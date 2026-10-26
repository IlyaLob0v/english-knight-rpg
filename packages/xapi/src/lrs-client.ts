import type { Statement } from "./types.js";

export interface LrsConfig {
  /** xAPI endpoint, e.g. https://lrs.example.com/xapi/ (with or without trailing slash). */
  endpoint: string;
  /** Basic-auth key and secret issued by the LRS. */
  key: string;
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The outcome of one POST of a batch:
 * - sent: stored (or already stored with the same id: xAPI resends are idempotent)
 * - retry: transient (network, 429, 5xx); try again later
 * - rejected: the LRS refused the batch (400/403/413...); retrying the same payload will not help
 */
export type SendOutcome =
  | { kind: "sent"; ids: string[] }
  | { kind: "retry"; reason: string; retryAfterMs?: number }
  | { kind: "rejected"; status: number; reason: string };

export interface StatementSink {
  send(statements: Statement[]): Promise<SendOutcome>;
}

const XAPI_VERSION = "1.0.3";

/** Filters of the xAPI GET /statements resource (xAPI 1.0.3, 2.1.3). */
export interface StatementQuery {
  agent?: Statement["actor"];
  verb?: string;
  activity?: string;
  /** Also match `activity` in context activities (concept, module), not only as the object. */
  related_activities?: boolean;
  registration?: string;
  since?: string;
  until?: string;
  limit?: number;
  ascending?: boolean;
}

export class LrsClient implements StatementSink {
  private readonly url: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: LrsConfig) {
    this.url = config.endpoint.replace(/\/?$/, "/") + "statements";
    this.auth = "Basic " + btoa(`${config.key}:${config.secret}`);
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Every statement matching the query, following the LRS's `more` pages. */
  async query(q: StatementQuery): Promise<Statement[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    const out: Statement[] = [];
    let next: string | undefined = `${this.url}?${params}`;
    while (next) {
      const res = await this.fetchImpl(next, {
        headers: { Authorization: this.auth, "X-Experience-API-Version": XAPI_VERSION, Accept: "application/json" },
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15000),
      });
      if (!res.ok) throw new Error(`LRS query: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const page = (await res.json()) as { statements: Statement[]; more?: string };
      out.push(...page.statements);
      // `more` is a path relative to the LRS host (xAPI 1.0.3, 2.1.3).
      next = page.more ? new URL(page.more, this.url).toString() : undefined;
    }
    return out;
  }

  async send(statements: Statement[]): Promise<SendOutcome> {
    if (statements.length === 0) return { kind: "sent", ids: [] };
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          Authorization: this.auth,
          "X-Experience-API-Version": XAPI_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(statements),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15000),
      });
    } catch (e) {
      return { kind: "retry", reason: `network: ${(e as Error).message}` };
    }
    if (res.ok) return { kind: "sent", ids: statements.map((s) => s.id) };
    const body = await res.text().catch(() => "");
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      return { kind: "retry", reason: `HTTP ${res.status}`, ...(retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}) };
    }
    // Includes 409: a statement with one of these ids exists with different content,
    // so resending the same payload can never succeed.
    return { kind: "rejected", status: res.status, reason: body.slice(0, 500) };
  }
}
