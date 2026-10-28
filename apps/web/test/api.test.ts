import { describe, expect, it } from "vitest";
import { Api, GatewaySink, SignedOutError, sessionFromFragment, startSession, type SessionInfo, type SessionStorage } from "../src/net/api.js";

function memoryStore(initial?: SessionInfo): SessionStorage & { value?: SessionInfo } {
  const s: SessionStorage & { value?: SessionInfo } = { load: () => s.value, save: (v) => void (s.value = v) };
  if (initial) s.value = initial;
  return s;
}

type Route = (req: { path: string; init: RequestInit }) => Response | Promise<Response>;
function fakeFetch(route: Route): typeof fetch {
  return (async (url: string, init: RequestInit = {}) => route({ path: new URL(url, "http://x").pathname.replace(/^\/api/, ""), init })) as typeof fetch;
}

const ME = { player_id: "guest_1234abcd", registration: "reg-2", xapi_base_iri: "https://moonbridge.test", lti: null };

describe("startSession", () => {
  it("prefers the LTI launch token from the URL fragment", async () => {
    const api = new Api("/api", fakeFetch(({ path, init }) => {
      expect(path).toBe("/session/me");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer lti-token");
      return Response.json({ ...ME, player_id: "p_lti" });
    }));
    const store = memoryStore();
    const { session, online } = await startSession(api, store, "#session=lti-token&module=A1_PastSimple_01");
    expect(online).toBe(true);
    expect(session).toMatchObject({ token: "lti-token", playerId: "p_lti", kind: "lti", ltiModuleId: "A1_PastSimple_01", xapiBaseIri: "https://moonbridge.test" });
    expect(store.value?.playerId).toBe("p_lti");
  });

  it("renews an expired guest session under the same player id", async () => {
    const calls: string[] = [];
    const api = new Api("/api", fakeFetch(({ path, init }) => {
      calls.push(path);
      if (path === "/session/me") {
        return new Headers(init.headers).get("Authorization") === "Bearer old" ? new Response(null, { status: 401 }) : Response.json(ME);
      }
      expect(JSON.parse(init.body as string)).toEqual({ player_id: "guest_1234abcd" });
      return Response.json({ token: "new", player_id: "guest_1234abcd", registration: "reg-2" });
    }));
    const store = memoryStore({ token: "old", playerId: "guest_1234abcd", registration: "reg-1", xapiBaseIri: "https://moonbridge.test", kind: "guest" });
    const { session } = await startSession(api, store, "");
    expect(session).toMatchObject({ token: "new", playerId: "guest_1234abcd", registration: "reg-2" });
    expect(calls).toEqual(["/session/me", "/session/guest", "/session/me"]);
  });

  it("asks a student whose account session expired to sign in again instead of starting a guest", async () => {
    const api = new Api("/api", fakeFetch(() => new Response(null, { status: 401 })));
    const store = memoryStore({
      token: "old",
      playerId: "player_0123456789abcdef",
      registration: "reg-1",
      xapiBaseIri: "https://moonbridge.test",
      kind: "account",
      account: { id: "acc_1", name: "Анна", role: "student", login: "anna" },
    });
    await expect(startSession(api, store, "")).rejects.toBeInstanceOf(SignedOutError);
  });

  it("starts offline with a local guest id the gateway will accept later", async () => {
    const api = new Api("/api", fakeFetch(() => Promise.reject(new TypeError("Failed to fetch"))));
    const { session, online } = await startSession(api, memoryStore(), "");
    expect(online).toBe(false);
    expect(session.playerId).toMatch(/^guest_[0-9a-f]{8}$/);
    expect(session.token).toBeUndefined();
  });

  it("reads the launch fragment", () => {
    expect(sessionFromFragment("#session=abc")).toEqual({ token: "abc" });
    expect(sessionFromFragment("")).toBeUndefined();
  });
});

describe("GatewaySink", () => {
  it("maps gateway answers to outbox outcomes and asks for a new session on 401", async () => {
    let status = 202;
    let renewals = 0;
    const api = new Api("/api", fakeFetch(() => new Response("{}", { status })));
    const sink = new GatewaySink(api, () => "t", () => renewals++);
    const statement = { id: "1" } as any;
    expect((await sink.send([statement])).kind).toBe("sent");
    status = 401;
    expect((await sink.send([statement])).kind).toBe("retry");
    expect(renewals).toBe(1);
    status = 503;
    expect((await sink.send([statement])).kind).toBe("retry");
    status = 400;
    expect((await sink.send([statement])).kind).toBe("rejected");
    expect((await new GatewaySink(api, () => undefined).send([statement])).kind).toBe("retry");
  });
});
