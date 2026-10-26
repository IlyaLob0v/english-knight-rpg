import { jwtVerify, type JWTPayload } from "jose";
import { CLAIM, type AgsEndpoint, type LaunchContext } from "./claims.js";
import type { PlatformRegistry } from "./platforms.js";

export interface PendingLogin {
  nonce: string;
  issuer: string;
  clientId: string;
  expiresAt: number;
}

/**
 * OIDC state → nonce, one-time. Kept server-side instead of in a cookie because
 * LMSs embed the tool in an iframe where third-party cookies are often blocked
 * (Safari). Postgres-backed in production (db/stores.ts), so a launch survives a
 * restart between the login redirect and the launch post.
 */
export interface LoginStates {
  create(issuer: string, clientId: string): Promise<{ state: string; nonce: string }>;
  /** Returns the login once and deletes it; expired logins come back undefined. */
  consume(state: string): Promise<PendingLogin | undefined>;
}

export class LoginStateStore implements LoginStates {
  private readonly pending = new Map<string, PendingLogin>();
  constructor(private readonly ttlMs = 5 * 60 * 1000, private readonly now: () => number = Date.now) {}

  async create(issuer: string, clientId: string): Promise<{ state: string; nonce: string }> {
    this.sweep();
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    this.pending.set(state, { nonce, issuer, clientId, expiresAt: this.now() + this.ttlMs });
    return { state, nonce };
  }

  async consume(state: string): Promise<PendingLogin | undefined> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    return p && p.expiresAt > this.now() ? p : undefined;
  }

  private sweep() {
    const now = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= now) this.pending.delete(k);
  }
}

export class LtiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export interface LoginRequest {
  iss?: string;
  login_hint?: string;
  target_link_uri?: string;
  lti_message_hint?: string;
  client_id?: string;
  lti_deployment_id?: string;
}

/** Step 1 of the launch: the LMS calls our login URL; we answer with a redirect to its auth endpoint. */
export async function buildAuthRedirect(req: LoginRequest, registry: PlatformRegistry, states: LoginStates, redirectUri: string): Promise<string> {
  if (!req.iss || !req.login_hint) throw new LtiError("login.params", "iss and login_hint are required");
  const platform = registry.find(req.iss, req.client_id);
  if (!platform) throw new LtiError("login.platform", `unknown platform ${req.iss}${req.client_id ? ` / ${req.client_id}` : ""}`);
  if (req.lti_deployment_id && !platform.deploymentIds.includes(req.lti_deployment_id)) {
    throw new LtiError("login.deployment", `unknown deployment ${req.lti_deployment_id}`);
  }
  const { state, nonce } = await states.create(platform.issuer, platform.clientId);
  const url = new URL(platform.authLoginUrl);
  const params: Record<string, string> = {
    scope: "openid",
    response_type: "id_token",
    response_mode: "form_post",
    prompt: "none",
    client_id: platform.clientId,
    redirect_uri: redirectUri,
    login_hint: req.login_hint,
    state,
    nonce,
    ...(req.lti_message_hint ? { lti_message_hint: req.lti_message_hint } : {}),
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** Step 2: the LMS posts a signed id_token; we verify it and extract the launch. */
export async function verifyLaunch(
  form: { id_token?: string; state?: string },
  registry: PlatformRegistry,
  states: LoginStates,
): Promise<LaunchContext> {
  if (!form.id_token || !form.state) throw new LtiError("launch.params", "id_token and state are required");
  const pending = await states.consume(form.state);
  if (!pending) throw new LtiError("launch.state", "unknown or expired state", 401);
  const platform = registry.find(pending.issuer, pending.clientId);
  if (!platform) throw new LtiError("launch.platform", "platform no longer registered", 401);

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(form.id_token, registry.keys(platform), {
      issuer: platform.issuer,
      audience: platform.clientId,
      algorithms: ["RS256"],
      maxTokenAge: "5m",
    }));
  } catch (e) {
    throw new LtiError("launch.token", `id_token rejected: ${(e as Error).message}`, 401);
  }

  if (payload.nonce !== pending.nonce) throw new LtiError("launch.nonce", "nonce mismatch", 401);
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== platform.clientId) {
    throw new LtiError("launch.azp", "azp must be our client id when aud has several values", 401);
  }
  const claim = <T>(name: string) => payload[name] as T | undefined;
  if (claim<string>(CLAIM.messageType) !== "LtiResourceLinkRequest") {
    throw new LtiError("launch.message_type", `unsupported message type ${String(claim(CLAIM.messageType))}`);
  }
  if (claim<string>(CLAIM.version) !== "1.3.0") throw new LtiError("launch.version", "LTI version must be 1.3.0");
  const deploymentId = claim<string>(CLAIM.deploymentId);
  if (!deploymentId || !platform.deploymentIds.includes(deploymentId)) {
    throw new LtiError("launch.deployment", `unknown deployment ${String(deploymentId)}`, 401);
  }
  const resourceLink = claim<{ id?: string }>(CLAIM.resourceLink);
  if (!resourceLink?.id) throw new LtiError("launch.resource_link", "resource_link.id is required");
  if (!payload.sub) throw new LtiError("launch.sub", "anonymous launches are not supported");

  const context = claim<{ id?: string }>(CLAIM.context);
  const ags = claim<AgsEndpoint>(CLAIM.ags);
  return {
    iss: platform.issuer,
    clientId: platform.clientId,
    deploymentId,
    sub: payload.sub,
    roles: claim<string[]>(CLAIM.roles) ?? [],
    ...(context?.id ? { contextId: context.id } : {}),
    resourceLinkId: resourceLink.id,
    ...(ags ? { ags } : {}),
    custom: claim<Record<string, string>>(CLAIM.custom) ?? {},
  };
}
