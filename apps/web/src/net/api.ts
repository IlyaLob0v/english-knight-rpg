import type { ContentBundle } from "@moonbridge/content";
import type { SendOutcome, Statement, StatementSink } from "@moonbridge/xapi";
import type { Snapshot } from "./backup.js";

/** What the client knows about its session; persisted so the game starts offline too. */
export interface SessionInfo {
  token?: string;
  playerId: string;
  registration: string;
  xapiBaseIri: string;
  /** "lti" sessions come from an LMS launch and cannot be renewed by the client. */
  kind: "guest" | "lti";
  /** custom.module_id of the LMS link, if the launch is bound to one module. */
  ltiModuleId?: string;
}

export const DEFAULT_XAPI_BASE_IRI = "https://moonbridge.example.com";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Client of the integration gateway (apps/server). */
export class Api {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly base: string, fetchImpl?: typeof fetch) {
    this.base = base.replace(/\/$/, "");
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async json<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init.body) headers.set("Content-Type", "application/json");
    const res = await this.fetchImpl(`${this.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new ApiError(res.status, `${init.method ?? "GET"} ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  guest(previousPlayerId?: string) {
    return this.json<{ token: string; player_id: string; registration: string }>("/session/guest", {
      method: "POST",
      body: JSON.stringify(previousPlayerId ? { player_id: previousPlayerId } : {}),
    });
  }

  me(token: string) {
    return this.json<{ player_id: string; registration: string; xapi_base_iri: string; lti: { module_id: string | null } | null }>(
      "/session/me",
      {},
      token,
    );
  }

  /** The content bundle, or "not-modified" when the cached hash is still current. */
  async bundle(cachedHash?: string): Promise<ContentBundle | "not-modified"> {
    const res = await this.fetchImpl(`${this.base}/content/bundle`, {
      headers: cachedHash ? { "If-None-Match": `"${cachedHash}"` } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 304) return "not-modified";
    if (!res.ok) throw new ApiError(res.status, `GET /content/bundle: HTTP ${res.status}`);
    return (await res.json()) as ContentBundle;
  }

  moduleResult(token: string, body: { module_id: string; correct: number; total: number }) {
    return this.json<{ passed: boolean; best: number; lms: string }>("/progress/module-result", { method: "POST", body: JSON.stringify(body) }, token);
  }

  /** The server's copy of the game state, or undefined when there is none yet. */
  async getSnapshot(token: string): Promise<Snapshot | undefined> {
    try {
      return await this.json<Snapshot>("/progress/snapshot", {}, token);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return undefined;
      throw e;
    }
  }

  /** Stores the game state; false when the server already holds a newer save. */
  async putSnapshot(token: string, body: Snapshot): Promise<boolean> {
    try {
      await this.json("/progress/snapshot", { method: "PUT", body: JSON.stringify(body) }, token);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return false;
      throw e;
    }
  }

  /** Posts statements to the gateway's xAPI intake, with the same outcome contract as an LRS client. */
  async postStatements(token: string | undefined, statements: Statement[]): Promise<SendOutcome> {
    if (statements.length === 0) return { kind: "sent", ids: [] };
    if (!token) return { kind: "retry", reason: "no session yet" };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/xapi/statements`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(statements),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      return { kind: "retry", reason: `network: ${(e as Error).message}` };
    }
    if (res.ok) return { kind: "sent", ids: statements.map((s) => s.id) };
    // 401: the session expired. The statements are fine; they go out after the session is renewed.
    if (res.status === 401 || res.status === 429 || res.status >= 500) return { kind: "retry", reason: `HTTP ${res.status}` };
    return { kind: "rejected", status: res.status, reason: (await res.text().catch(() => "")).slice(0, 500) };
  }
}

/** The client side of the outbox delivers to the gateway, which owns the LRS credentials. */
export class GatewaySink implements StatementSink {
  constructor(private readonly api: Api, private readonly token: () => string | undefined, private readonly onUnauthorized?: () => void) {}

  async send(statements: Statement[]): Promise<SendOutcome> {
    const outcome = await this.api.postStatements(this.token(), statements);
    if (outcome.kind === "retry" && outcome.reason === "HTTP 401") this.onUnauthorized?.();
    return outcome;
  }
}

export interface SessionStorage {
  load(): SessionInfo | undefined;
  save(s: SessionInfo): void;
}

export const localSessionStorage: SessionStorage = {
  load() {
    try {
      const raw = localStorage.getItem("moonbridge.session");
      return raw ? (JSON.parse(raw) as SessionInfo) : undefined;
    } catch {
      return undefined;
    }
  },
  save(s) {
    try {
      localStorage.setItem("moonbridge.session", JSON.stringify(s));
    } catch {
      // Private mode: the session lives for this page only.
    }
  },
};

/** Reads `#session=<token>&module=<id>` left by an LTI launch. */
export function sessionFromFragment(hash: string): { token: string; moduleId?: string } | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("session");
  if (!token) return undefined;
  const moduleId = params.get("module");
  return { token, ...(moduleId ? { moduleId } : {}) };
}

/**
 * Starts a session: an LTI launch token from the URL wins, then the stored session,
 * then a guest session. Without a network the stored session (or a new local guest
 * id) is used, and statements wait in the outbox until the gateway is reachable.
 */
export async function startSession(api: Api, store: SessionStorage, fragment: string): Promise<{ session: SessionInfo; online: boolean }> {
  const launch = sessionFromFragment(fragment);
  const stored = store.load();
  try {
    if (launch) {
      const me = await api.me(launch.token);
      const session: SessionInfo = {
        token: launch.token,
        playerId: me.player_id,
        registration: me.registration,
        xapiBaseIri: me.xapi_base_iri,
        kind: "lti",
        ...(launch.moduleId ? { ltiModuleId: launch.moduleId } : {}),
      };
      store.save(session);
      return { session, online: true };
    }
    if (stored?.token) {
      try {
        const me = await api.me(stored.token);
        const session = { ...stored, registration: me.registration, xapiBaseIri: me.xapi_base_iri };
        store.save(session);
        return { session, online: true };
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401) || stored.kind === "lti") throw e;
      }
    }
    const session = await renewGuest(api, stored?.playerId);
    store.save(session);
    return { session, online: true };
  } catch (e) {
    if (e instanceof ApiError && e.status !== 401 && e.status < 500) throw e;
    const session: SessionInfo = stored ?? {
      playerId: `guest_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
      registration: crypto.randomUUID(),
      xapiBaseIri: DEFAULT_XAPI_BASE_IRI,
      kind: "guest",
    };
    store.save(session);
    return { session, online: false };
  }
}

export async function renewGuest(api: Api, previousPlayerId?: string): Promise<SessionInfo> {
  const g = await api.guest(previousPlayerId);
  const me = await api.me(g.token);
  return { token: g.token, playerId: g.player_id, registration: g.registration, xapiBaseIri: me.xapi_base_iri, kind: "guest" };
}
