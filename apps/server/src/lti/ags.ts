import { SignJWT } from "jose";
import { AGS_SCOPE, type AgsEndpoint } from "./claims.js";
import type { ToolKeys } from "./keys.js";
import type { PlatformConfig } from "./platforms.js";

export interface AgsScore {
  /** The LMS user id (LTI sub). */
  userId: string;
  scoreGiven: number;
  scoreMaximum: number;
  comment?: string;
  activityProgress: "Initialized" | "Started" | "InProgress" | "Submitted" | "Completed";
  gradingProgress: "FullyGraded" | "Pending" | "PendingManual" | "Failed" | "NotReady";
  timestamp: string;
}

export interface LineItem {
  id: string;
  label: string;
  scoreMaximum: number;
  resourceId?: string;
}

export class AgsError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
  }
}

/** Inserts a path segment before the query string: lineitem URLs may carry query params. */
export function appendPath(url: string, segment: string): string {
  const u = new URL(url);
  u.pathname = u.pathname.replace(/\/?$/, `/${segment}`);
  return u.toString();
}

/**
 * LTI Assignment and Grade Services client: one score per module in the LMS
 * gradebook. Everything else (errors, game events) goes to the LRS, not here.
 */
export class AgsClient {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly keys: ToolKeys, fetchImpl?: typeof fetch, private readonly now: () => number = Date.now) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** OAuth2 client_credentials with a signed JWT client assertion (RFC 7523), cached until shortly before expiry. */
  async accessToken(platform: PlatformConfig, scopes: string[]): Promise<string> {
    const scope = [...scopes].sort().join(" ");
    const cacheKey = `${platform.issuer}\u0000${platform.clientId}\u0000${scope}`;
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt > this.now() + 30_000) return cached.token;

    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: this.keys.alg, kid: this.keys.kid, typ: "JWT" })
      .setIssuer(platform.clientId)
      .setSubject(platform.clientId)
      .setAudience(platform.authTokenAudience ?? platform.authTokenUrl)
      .setIssuedAt()
      .setExpirationTime("5m")
      .setJti(crypto.randomUUID())
      .sign(this.keys.privateKey);

    const res = await this.call(platform.authTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
        scope,
      }),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new AgsError("token endpoint returned no access_token", res.status);
    this.tokens.set(cacheKey, { token: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  /**
   * The gradebook line item for a module:
   * 1. the launch's own line item, when the LMS link was created for this module
   *    (custom parameter module_id);
   * 2. otherwise one found or created by resourceId = module id, if the platform
   *    granted the lineitem scope;
   * 3. otherwise the launch's line item as the single gradebook column.
   */
  async lineItemFor(
    platform: PlatformConfig,
    ags: AgsEndpoint,
    module: { moduleId: string; label: string; scoreMaximum: number },
    launchModuleId?: string,
  ): Promise<string> {
    const { moduleId, label, scoreMaximum } = module;
    if (ags.lineitem && launchModuleId === moduleId) return ags.lineitem;
    if (!ags.lineitems || !ags.scope.includes(AGS_SCOPE.lineItem)) {
      if (ags.lineitem) return ags.lineitem;
      throw new AgsError("launch has no usable AGS line item");
    }
    const token = await this.accessToken(platform, [AGS_SCOPE.lineItem]);
    const list = new URL(ags.lineitems);
    list.searchParams.set("resource_id", moduleId);
    const res = await this.call(list.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.ims.lis.v2.lineitemcontainer+json" },
    });
    const items = (await res.json()) as LineItem[];
    const existing = items.find((i) => i.resourceId === moduleId);
    if (existing) return existing.id;

    const created = await this.call(ags.lineitems, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.ims.lis.v2.lineitem+json" },
      body: JSON.stringify({ label, scoreMaximum, resourceId: moduleId }),
    });
    return ((await created.json()) as LineItem).id;
  }

  async submitScore(platform: PlatformConfig, lineItemUrl: string, score: AgsScore): Promise<void> {
    const token = await this.accessToken(platform, [AGS_SCOPE.score]);
    await this.call(appendPath(lineItemUrl, "scores"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.ims.lis.v1.score+json" },
      body: JSON.stringify(score),
    });
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) });
    } catch (e) {
      throw new AgsError(`network: ${(e as Error).message}`, undefined, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgsError(`${init.method ?? "GET"} ${url} → HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, res.status >= 500 || res.status === 429);
    }
    return res;
  }
}
