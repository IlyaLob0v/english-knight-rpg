import { describe, expect, it } from "vitest";
import { Api } from "../src/net/api.js";
import { ProgressBackup, type Snapshot } from "../src/net/backup.js";
import { MemoryKeyValue } from "../src/storage/idb.js";

/** A gateway that stores one snapshot with the server's newest-wins rule. */
function fakeServer(initial?: Snapshot) {
  const server = { stored: initial, puts: 0, down: false };
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    if (server.down) throw new TypeError("network down");
    expect(new URL(url, "http://x").pathname).toBe("/api/progress/snapshot");
    if ((init.method ?? "GET") === "GET") return server.stored ? Response.json(server.stored) : new Response(null, { status: 404 });
    server.puts++;
    const body = JSON.parse(init.body as string) as Snapshot;
    if (server.stored && server.stored.saved_at >= body.saved_at) return Response.json({ accepted: false }, { status: 409 });
    server.stored = body;
    return Response.json({ accepted: true, saved_at: body.saved_at });
  }) as typeof fetch;
  return { server, api: new Api("/api", fetchImpl) };
}

const clock = (iso: string) => {
  const c = { t: new Date(iso), tick: (ms: number) => (c.t = new Date(c.t.getTime() + ms)) };
  return c;
};

describe("ProgressBackup", () => {
  it("pushes saved progress shortly after a save, once", async () => {
    const { server, api } = fakeServer();
    const c = clock("2026-10-26T10:00:00Z");
    const kv = new ProgressBackup(new MemoryKeyValue(), api, () => "t", () => c.t, 1);
    await kv.set("moonbridge", { completed_episodes: ["e5"] });
    await kv.set("content-bundle", { big: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(server.stored).toEqual({ saved_at: "2026-10-26T10:00:00.000Z", snapshot: { moonbridge: { completed_episodes: ["e5"] } } });
    await kv.push();
    expect(server.puts).toBe(1);
  });

  it("restores the server's copy on a device without local state", async () => {
    const { api } = fakeServer({ saved_at: "2026-10-26T09:00:00.000Z", snapshot: { moonbridge: { completed_episodes: ["e40"] }, "fsrs-cards": [{ id: "c" }] } });
    const local = new MemoryKeyValue();
    const kv = new ProgressBackup(local, api, () => "t");
    expect(await kv.restore()).toBe("restored");
    expect(await local.get("moonbridge")).toEqual({ completed_episodes: ["e40"] });
    expect(await local.get("fsrs-cards")).toEqual([{ id: "c" }]);
    expect(await kv.restore()).toBe("unchanged");
  });

  it("keeps newer local progress and sends it, takes newer server progress", async () => {
    const { server, api } = fakeServer({ saved_at: "2026-10-26T09:00:00.000Z", snapshot: { moonbridge: { completed_episodes: ["e40"] } } });
    const c = clock("2026-10-26T10:00:00Z");
    const local = new MemoryKeyValue();
    const kv = new ProgressBackup(local, api, () => "t", () => c.t, 60_000);
    await kv.set("moonbridge", { completed_episodes: ["e50"] });
    expect(await kv.restore()).toBe("pushed");
    expect(server.stored?.snapshot).toEqual({ moonbridge: { completed_episodes: ["e50"] } });

    // Another device played later.
    server.stored = { saved_at: "2026-10-26T11:00:00.000Z", snapshot: { moonbridge: { completed_episodes: ["e70"] } } };
    expect(await kv.restore()).toBe("restored");
    expect(await local.get("moonbridge")).toEqual({ completed_episodes: ["e70"] });
  });

  it("plays on offline and sends the state when the server is back", async () => {
    const { server, api } = fakeServer();
    server.down = true;
    const local = new MemoryKeyValue();
    const kv = new ProgressBackup(local, api, () => "t", () => new Date("2026-10-26T10:00:00Z"), 60_000);
    expect(await kv.restore()).toBe("offline");
    await kv.set("moonbridge", { completed_episodes: ["e1"] });
    await kv.push();
    expect(server.stored).toBeUndefined();
    server.down = false;
    await kv.push();
    expect(server.stored?.snapshot).toEqual({ moonbridge: { completed_episodes: ["e1"] } });
  });
});
