import { validateContent } from "@knight/content";
import { buildBundle, loadContentDir } from "@knight/content/node";
import { MemoryOutboxStore, Outbox, StatementBuilder, type Statement } from "@knight/xapi";
import type { FastifyInstance } from "fastify";
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { AgsClient, appendPath } from "../src/lti/ags.js";
import { AGS_SCOPE, CLAIM } from "../src/lti/claims.js";
import { MemoryIdentityStore } from "../src/lti/identity.js";
import { loadToolKeys } from "../src/lti/keys.js";
import { LoginStateStore } from "../src/lti/launch.js";
import { PlatformRegistry, type PlatformConfig } from "../src/lti/platforms.js";
import { MemoryScoreStore } from "../src/scores.js";
import { SessionTokens } from "../src/session.js";

const CONTENT_DIR = new URL("../../../content", import.meta.url).pathname;

const platform: PlatformConfig = {
  issuer: "https://moodle.test",
  clientId: "knight-client",
  deploymentIds: ["dep-1"],
  authLoginUrl: "https://moodle.test/mod/lti/auth.php",
  authTokenUrl: "https://moodle.test/mod/lti/token.php",
  jwksUrl: "https://moodle.test/mod/lti/certs.php",
};

let platformKey: CryptoKey;
let platformJwk: JWK;
let bundle: Awaited<ReturnType<typeof buildBundle>>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  platformKey = pair.privateKey;
  platformJwk = { ...(await exportJWK(pair.publicKey)), kid: "moodle-1", alg: "RS256" };
  const { source } = await loadContentDir(CONTENT_DIR);
  bundle = buildBundle(validateContent(source).content!);
});

interface Harness {
  app: FastifyInstance;
  sent: Statement[];
  agsCalls: { url: string; init: RequestInit }[];
  outbox: Outbox;
}

let current: FastifyInstance | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function harness(): Promise<Harness> {
  const config = loadConfig({ NODE_ENV: "test", ADMIN_TOKEN: "admin-secret", PUBLIC_URL: "https://knight.test", CLIENT_URL: "https://play.knight.test/" });
  const sent: Statement[] = [];
  const outbox = new Outbox(new MemoryOutboxStore(), { send: async (b) => (sent.push(...b), { kind: "sent", ids: b.map((s) => s.id) }) });
  const agsCalls: Harness["agsCalls"] = [];
  const agsFetch = (async (url: string, init: RequestInit) => {
    agsCalls.push({ url, init });
    if (url === platform.authTokenUrl) return Response.json({ access_token: "lms-token", expires_in: 3600 });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const toolKeys = await loadToolKeys("tool-1");
  const app = await buildApp({
    config,
    bundle,
    outbox,
    tokens: new SessionTokens(config.sessionSecret, 3600),
    platforms: new PlatformRegistry([platform], () => createLocalJWKSet({ keys: [platformJwk] })),
    loginStates: new LoginStateStore(),
    identities: new MemoryIdentityStore(),
    ags: new AgsClient(toolKeys, agsFetch),
    scores: new MemoryScoreStore(),
    toolKeys,
  });
  current = app;
  return { app, sent, agsCalls, outbox };
}

async function idToken(nonce: string, overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    nonce,
    [CLAIM.messageType]: "LtiResourceLinkRequest",
    [CLAIM.version]: "1.3.0",
    [CLAIM.deploymentId]: "dep-1",
    [CLAIM.targetLinkUri]: "https://knight.test/lti/launch",
    [CLAIM.resourceLink]: { id: "rl-42" },
    [CLAIM.roles]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    [CLAIM.context]: { id: "course-7" },
    [CLAIM.custom]: { module_id: "A1_PastSimple_01" },
    [CLAIM.ags]: { scope: [AGS_SCOPE.score], lineitem: "https://moodle.test/mod/lti/services.php/2/lineitems/9/lineitem?type_id=1" },
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "moodle-1" })
    .setIssuer(platform.issuer)
    .setAudience(platform.clientId)
    .setSubject("moodle-user-17")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(platformKey);
}

async function login(app: FastifyInstance) {
  const res = await app.inject({
    method: "POST",
    url: "/lti/login",
    payload: new URLSearchParams({ iss: platform.issuer, login_hint: "17", target_link_uri: "https://knight.test/lti/launch", client_id: platform.clientId }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(res.statusCode).toBe(302);
  const redirect = new URL(res.headers.location as string);
  return { redirect, state: redirect.searchParams.get("state")!, nonce: redirect.searchParams.get("nonce")! };
}

async function launch(app: FastifyInstance, form: Record<string, string>) {
  return app.inject({ method: "POST", url: "/lti/launch", payload: new URLSearchParams(form).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
}

function sessionFrom(html: string): string {
  const url = new URL(/url=([^"]+)"/.exec(html)![1]!.replaceAll("&amp;", "&"));
  return new URLSearchParams(url.hash.slice(1)).get("session")!;
}

describe("LTI 1.3 launch", () => {
  it("redirects the OIDC login to the platform with state and nonce", async () => {
    const { app } = await harness();
    const { redirect } = await login(app);
    expect(redirect.origin + redirect.pathname).toBe(platform.authLoginUrl);
    expect(Object.fromEntries(redirect.searchParams)).toMatchObject({
      scope: "openid",
      response_type: "id_token",
      response_mode: "form_post",
      prompt: "none",
      client_id: platform.clientId,
      redirect_uri: "https://knight.test/lti/launch",
      login_hint: "17",
    });
  });

  it("verifies the id_token and hands the client a session token in the URL fragment", async () => {
    const { app } = await harness();
    const { state, nonce } = await login(app);
    const res = await launch(app, { id_token: await idToken(nonce), state });
    expect(res.statusCode).toBe(200);
    const token = sessionFrom(res.body);
    const claims = decodeJwt(token);
    expect(claims.sub).toMatch(/^player_/);
    expect(claims.lti).toMatchObject({ iss: platform.issuer, sub: "moodle-user-17", moduleId: "A1_PastSimple_01" });
  });

  it("maps the same LMS user to the same player on every launch", async () => {
    const { app } = await harness();
    const players = [];
    for (let i = 0; i < 2; i++) {
      const { state, nonce } = await login(app);
      players.push(decodeJwt(sessionFrom((await launch(app, { id_token: await idToken(nonce), state })).body)).sub);
    }
    expect(players[0]).toBe(players[1]);
  });

  it("rejects a wrong nonce, a replayed state, an unknown deployment and a foreign signature", async () => {
    const { app } = await harness();
    let { state, nonce } = await login(app);
    expect((await launch(app, { id_token: await idToken("other-nonce"), state })).json().error).toBe("launch.nonce");
    expect((await launch(app, { id_token: await idToken(nonce), state })).json().error).toBe("launch.state");

    ({ state, nonce } = await login(app));
    expect((await launch(app, { id_token: await idToken(nonce, { [CLAIM.deploymentId]: "dep-x" }), state })).json().error).toBe("launch.deployment");

    ({ state, nonce } = await login(app));
    const stranger = await generateKeyPair("RS256");
    const forged = await new SignJWT({ nonce }).setProtectedHeader({ alg: "RS256", kid: "moodle-1" }).setIssuer(platform.issuer)
      .setAudience(platform.clientId).setSubject("x").setIssuedAt().setExpirationTime("5m").sign(stranger.privateKey);
    const res = await launch(app, { id_token: forged, state });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("launch.token");
  });

  it("refuses logins from unknown platforms", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/lti/login?iss=https://evil.test&login_hint=1" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("login.platform");
  });

  it("serves the tool's public key and nothing private", async () => {
    const { app } = await harness();
    const { keys } = (await app.inject({ url: "/.well-known/jwks.json" })).json();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "RSA", kid: "tool-1", alg: "RS256", use: "sig" });
    expect(keys[0].d).toBeUndefined();
  });
});

describe("module result → AGS", () => {
  it("sends the best score to the launch's line item with a signed client assertion", async () => {
    const { app, agsCalls } = await harness();
    const { state, nonce } = await login(app);
    const token = sessionFrom((await launch(app, { id_token: await idToken(nonce), state })).body);
    const post = (correct: number) =>
      app.inject({ method: "POST", url: "/progress/module-result", headers: { authorization: `Bearer ${token}` }, payload: { module_id: "A1_PastSimple_01", correct, total: 10 } });

    expect((await post(9)).json()).toMatchObject({ passed: true, best: 0.9, lms: "sent" });
    const tokenCall = agsCalls.find((c) => c.url === platform.authTokenUrl)!;
    const form = new URLSearchParams(tokenCall.init.body as URLSearchParams);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(decodeJwt(form.get("client_assertion")!)).toMatchObject({ iss: platform.clientId, sub: platform.clientId, aud: platform.authTokenUrl });

    const scoreCall = agsCalls.find((c) => c.url.includes("/scores"))!;
    expect(scoreCall.url).toBe("https://moodle.test/mod/lti/services.php/2/lineitems/9/lineitem/scores?type_id=1");
    expect(JSON.parse(scoreCall.init.body as string)).toMatchObject({ userId: "moodle-user-17", scoreGiven: 90, scoreMaximum: 100, gradingProgress: "FullyGraded" });

    expect((await post(6)).json()).toMatchObject({ passed: false, best: 0.9, lms: "not_improved" });
    expect(agsCalls.filter((c) => c.url.includes("/scores"))).toHaveLength(1);
  });

  it("works without an LMS for guest sessions", async () => {
    const { app } = await harness();
    const { token } = (await app.inject({ method: "POST", url: "/session/guest" })).json();
    const res = await app.inject({ method: "POST", url: "/progress/module-result", headers: { authorization: `Bearer ${token}` }, payload: { module_id: "A1_VerbToBe_01", correct: 8, total: 8 } });
    expect(res.json()).toMatchObject({ passed: true, lms: "not_lti" });
  });

  it("keeps a returning guest's player id and describes the session", async () => {
    const { app } = await harness();
    const first = (await app.inject({ method: "POST", url: "/session/guest" })).json();
    const again = (await app.inject({ method: "POST", url: "/session/guest", payload: { player_id: first.player_id } })).json();
    expect(again.player_id).toBe(first.player_id);
    expect(again.registration).not.toBe(first.registration);
    const forged = (await app.inject({ method: "POST", url: "/session/guest", payload: { player_id: "lti_admin" } })).json();
    expect(forged.player_id).toMatch(/^guest_[0-9a-f]{8}$/);

    const me = await app.inject({ url: "/session/me", headers: { authorization: `Bearer ${again.token}` } });
    expect(me.json()).toEqual({ player_id: first.player_id, registration: again.registration, xapi_base_iri: "https://knight.example.com", lti: null });
    expect((await app.inject({ url: "/session/me" })).statusCode).toBe(401);
  });

  it("appends /scores before the query string", () => {
    expect(appendPath("https://lms.test/li/9?x=1", "scores")).toBe("https://lms.test/li/9/scores?x=1");
    expect(appendPath("https://lms.test/li/9/", "scores")).toBe("https://lms.test/li/9/scores");
  });
});

describe("xAPI intake", () => {
  it("accepts the session player's statements and forwards them to the LRS once", async () => {
    const { app, sent, outbox } = await harness();
    const { token, player_id } = (await app.inject({ method: "POST", url: "/session/guest" })).json();
    const st = new StatementBuilder().defeated({ playerId: player_id, enemyId: "ash_imp" });
    const post = () => app.inject({ method: "POST", url: "/xapi/statements", headers: { authorization: `Bearer ${token}` }, payload: [st] });
    expect((await post()).statusCode).toBe(202);
    expect((await post()).json()).toMatchObject({ accepted: 1, new: 0 });
    await outbox.flush();
    expect(sent.map((s) => s.id)).toEqual([st.id]);
  });

  it("rejects statements about another player and requests without a session", async () => {
    const { app } = await harness();
    const { token } = (await app.inject({ method: "POST", url: "/session/guest" })).json();
    const st = new StatementBuilder().defeated({ playerId: "someone_else", enemyId: "ash_imp" });
    const res = await app.inject({ method: "POST", url: "/xapi/statements", headers: { authorization: `Bearer ${token}` }, payload: [st] });
    expect(res.statusCode).toBe(400);
    expect(res.json().rejected[0].errors).toEqual(["actor does not match the session"]);
    expect((await app.inject({ method: "POST", url: "/xapi/statements", payload: [st] })).statusCode).toBe(401);
  });
});

describe("Content API", () => {
  it("serves the bundle with an ETag", async () => {
    const { app } = await harness();
    const first = await app.inject({ url: "/content/bundle" });
    expect(first.json().content_hash).toBe(bundle.content_hash);
    const again = await app.inject({ url: "/content/bundle", headers: { "if-none-match": first.headers.etag as string } });
    expect(again.statusCode).toBe(304);
  });

  it("swaps in valid content and refuses invalid content", async () => {
    const { app } = await harness();
    const { source } = await loadContentDir(CONTENT_DIR);
    const put = (body: unknown, auth = "Bearer admin-secret") =>
      app.inject({ method: "PUT", url: "/content/source", headers: { authorization: auth }, payload: body as object });

    expect((await put(source, "Bearer wrong")).statusCode).toBe(401);

    const broken = structuredClone(source);
    (broken.taskSets[0]!.data as any).tasks[0].concept_id = "nope.missing";
    const bad = await put(broken);
    expect(bad.statusCode).toBe(422);
    expect(bad.json().issues.map((i: any) => i.code)).toContain("ref.concept");
    expect((await app.inject({ url: "/content/manifest" })).json().content_hash).toBe(bundle.content_hash);

    const changed = structuredClone(source);
    const steps = (changed.tracks[0]!.data as any).chapters[0].steps;
    [steps[1], steps[2]] = [steps[2], steps[1]];
    const ok = await put(changed);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().content_hash).not.toBe(bundle.content_hash);
  });
});
