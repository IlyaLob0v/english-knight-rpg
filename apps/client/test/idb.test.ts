import "fake-indexeddb/auto";
import { MemoryOutboxStore, Outbox, StatementBuilder, type OutboxStore } from "@knight/xapi";
import { describe, expect, it } from "vitest";
import { IdbOutboxStore, openPlayerDb } from "../src/storage/idb.js";

const builder = new StatementBuilder();
const st = (n: number) => builder.defeated({ playerId: "p1", enemyId: `e${n}`, timestamp: new Date(Date.UTC(2026, 9, 26, 8, 0, n)) });

// The IndexedDB store must behave exactly like the reference in-memory store.
describe.each([
  ["memory", async () => new MemoryOutboxStore() as OutboxStore],
  ["indexeddb", async () => new IdbOutboxStore(await openPlayerDb(`outbox-${crypto.randomUUID()}`)) as OutboxStore],
])("OutboxStore contract: %s", (_name, make) => {
  it("enqueues idempotently, including ids already sent or dead", async () => {
    const store = await make();
    const [a, b, c] = [st(1), st(2), st(3)];
    expect(await store.enqueue([a, b, c], 0)).toBe(3);
    expect(await store.enqueue([a], 0)).toBe(0);
    await store.markSent([a.id]);
    await store.markDead([b.id], "bad");
    expect(await store.enqueue([a, b], 0)).toBe(0);
    expect(await store.pendingCount()).toBe(1);
    expect((await store.due(0, 10)).map((e) => e.statement.id)).toEqual([c.id]);
  });

  it("reschedules with backoff and returns due entries in queue order", async () => {
    const store = await make();
    const [a, b] = [st(1), st(2)];
    await store.enqueue([a, b], 0);
    await store.reschedule([a.id], 5000, "HTTP 503");
    expect((await store.due(0, 10)).map((e) => e.statement.id)).toEqual([b.id]);
    const later = await store.due(5000, 10);
    expect(later.map((e) => e.statement.id)).toEqual([a.id, b.id]);
    expect(later[0]).toMatchObject({ attempts: 1, lastError: "HTTP 503" });
  });

  it("drains through an Outbox after a failure", async () => {
    const store = await make();
    let up = false;
    const sent: string[] = [];
    let clock = 0;
    const outbox = new Outbox(store, { send: async (b) => (up ? (sent.push(...b.map((s) => s.id)), { kind: "sent", ids: [] }) : { kind: "retry", reason: "down" }) }, { now: () => clock, random: () => 0.5 });
    await outbox.enqueue([st(1), st(2)]);
    expect(await outbox.flush()).toEqual({ sent: 0, retried: 2, dead: 0 });
    up = true;
    clock = 60_000;
    expect(await outbox.flush()).toEqual({ sent: 2, retried: 0, dead: 0 });
    expect(await store.pendingCount()).toBe(0);
  });
});
