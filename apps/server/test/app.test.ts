import { loadContentDir } from "@moonbridge/content/node";
import { StatementBuilder } from "@moonbridge/xapi";
import { decodeJwt, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { appendPath } from "../src/lti/ags.js";
import { CLAIM } from "../src/lti/claims.js";
import { bundle, CONTENT_DIR, harness, idToken, launch, login, platform, sessionFrom } from "./harness.js";

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
      redirect_uri: "https://moonbridge.test/lti/launch",
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

  it("queues the grade while the LMS is down and delivers it on the next flush", async () => {
    const { app, agsCalls, grades, lms } = await harness();
    const { state, nonce } = await login(app);
    const token = sessionFrom((await launch(app, { id_token: await idToken(nonce), state })).body);
    lms.down = true;
    const res = await app.inject({ method: "POST", url: "/progress/module-result", headers: { authorization: `Bearer ${token}` }, payload: { module_id: "A1_PastSimple_01", correct: 8, total: 10 } });
    expect(res.json()).toMatchObject({ passed: true, best: 0.8, lms: "queued" });
    expect(await grades.flush()).toEqual({ sent: 0, retried: 1, failed: 0 });

    lms.down = false;
    expect(await grades.flush()).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(JSON.parse(agsCalls.find((c) => c.url.includes("/scores"))!.init.body as string)).toMatchObject({ scoreGiven: 80 });
    expect(await grades.flush()).toEqual({ sent: 0, retried: 0, failed: 0 });
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
    expect(me.json()).toEqual({ player_id: first.player_id, registration: again.registration, xapi_base_iri: "https://moonbridge.example.com", lti: null });
    expect((await app.inject({ url: "/session/me" })).statusCode).toBe(401);
  });

  it("appends /scores before the query string", () => {
    expect(appendPath("https://lms.test/li/9?x=1", "scores")).toBe("https://lms.test/li/9/scores?x=1");
    expect(appendPath("https://lms.test/li/9/", "scores")).toBe("https://lms.test/li/9/scores");
  });
});

describe("progress backup", () => {
  it("keeps the newest snapshot per player and refuses older ones", async () => {
    const { app } = await harness();
    const { token } = (await app.inject({ method: "POST", url: "/session/guest" })).json();
    const auth = { authorization: `Bearer ${token}` };
    expect((await app.inject({ url: "/progress/snapshot", headers: auth })).statusCode).toBe(404);

    const put = (savedAt: string, xp: number) => app.inject({ method: "PUT", url: "/progress/snapshot", headers: auth, payload: { saved_at: savedAt, snapshot: { progress: { xp } } } });
    expect((await put("2026-10-26T10:00:00.000Z", 10)).json()).toEqual({ accepted: true, saved_at: "2026-10-26T10:00:00.000Z" });
    expect((await put("2026-10-26T09:00:00.000Z", 5)).statusCode).toBe(409);
    expect((await put("2999-01-01T00:00:00.000Z", 99)).statusCode).toBe(400);

    const got = (await app.inject({ url: "/progress/snapshot", headers: auth })).json();
    expect(got).toEqual({ saved_at: "2026-10-26T10:00:00.000Z", snapshot: { progress: { xp: 10 } } });

    const other = (await app.inject({ method: "POST", url: "/session/guest" })).json();
    expect((await app.inject({ url: "/progress/snapshot", headers: { authorization: `Bearer ${other.token}` } })).statusCode).toBe(404);
  });
});

describe("xAPI intake", () => {
  it("accepts the session player's statements and forwards them to the LRS once", async () => {
    const { app, sent, outbox } = await harness();
    const { token, player_id } = (await app.inject({ method: "POST", url: "/session/guest" })).json();
    const st = new StatementBuilder().unlocked({ playerId: player_id, placeId: "reception", moduleId: "A1_VerbToBe_01" });
    const post = () => app.inject({ method: "POST", url: "/xapi/statements", headers: { authorization: `Bearer ${token}` }, payload: [st] });
    expect((await post()).statusCode).toBe(202);
    expect((await post()).json()).toMatchObject({ accepted: 1, new: 0 });
    await outbox.flush();
    expect(sent.map((s) => s.id)).toEqual([st.id]);
  });

  it("rejects statements about another player and requests without a session", async () => {
    const { app } = await harness();
    const { token } = (await app.inject({ method: "POST", url: "/session/guest" })).json();
    const st = new StatementBuilder().unlocked({ playerId: "someone_else", placeId: "reception", moduleId: "A1_VerbToBe_01" });
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

  it("serves media from the content folder and nothing outside it", async () => {
    const { app } = await harness();
    const art = await app.inject({ url: "/content/media/places/reception.svg" });
    expect(art.statusCode).toBe(200);
    expect(art.headers["content-type"]).toBe("image/svg+xml");
    expect(art.body).toContain("<svg");
    expect((await app.inject({ url: "/content/media/places/missing.webp" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/content/media/..%2Fcourses%2Ffixture_a1.json" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/content/media/%2E%2E/%2E%2E/package.svg" })).statusCode).toBe(404);
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
    // A content change the platform accepts: a new episode line.
    const episode = changed.episodes!.find((e) => (e.data as any).episode_id === "to_be_at_reception")!;
    (episode.data as any).steps[0].text.ru = "Добро пожаловать!";
    const ok = await put(changed);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().content_hash).not.toBe(bundle.content_hash);
  });
});
