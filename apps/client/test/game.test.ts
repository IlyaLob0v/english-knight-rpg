import "fake-indexeddb/auto";
import type { ContentBundle } from "@knight/content";
import { MemoryJournal } from "@knight/learning";
import { MemoryOutboxStore, validateStatement, type Statement, type StatementSink } from "@knight/xapi";
import { beforeAll, describe, expect, it } from "vitest";
import { Game, type PendingResult } from "../src/game/game.js";
import { IdbJournal, IdbKeyValue, IdbOutboxStore, MemoryKeyValue, openPlayerDb } from "../src/storage/idb.js";
import { answerFor, loadBundle } from "./fixtures.js";

let bundle: ContentBundle;
beforeAll(async () => {
  bundle = await loadBundle();
});

const BASE = "https://knight.test";

function deps(overrides: Partial<Parameters<typeof Game.load>[0]> = {}) {
  const delivered: Statement[] = [];
  let online = true;
  const sink: StatementSink = {
    send: async (b) => (online ? (delivered.push(...b), { kind: "sent", ids: b.map((s) => s.id) }) : { kind: "retry", reason: "offline" }),
  };
  const reported: PendingResult[] = [];
  return {
    delivered,
    reported,
    setOnline: (v: boolean) => (online = v),
    deps: {
      bundle,
      playerId: "guest_0000abcd",
      registration: "2b9e7c41-3f0a-4d8e-b6a2-91c4e5d7f803",
      xapiBaseIri: BASE,
      kv: new MemoryKeyValue(),
      journal: new MemoryJournal(),
      outboxStore: new MemoryOutboxStore(),
      sink,
      reportModuleResult: async (r: PendingResult) => {
        if (!online) throw new Error("offline");
        reported.push(r);
      },
      ...overrides,
    },
  };
}

async function fight(game: Game, step: number, kind: "encounter" | "boss", answer: "right" | "wrong") {
  const battle = game.startBattle(step, kind);
  while (battle.state === "ongoing") {
    const task = battle.nextTask();
    await game.answer(battle, task, { response: answerFor(task, answer), hintUsed: false, durationMs: 4000 });
  }
  return game.finishBattle(battle);
}

describe("Game", () => {
  it("plays a step from first encounter to the boss, with valid xAPI for every answer and the score for the LMS", async () => {
    const h = deps();
    const game = await Game.load(h.deps);
    await game.launched();
    const step = game.steps()[0]!;
    expect(() => game.startBattle(0, "boss")).toThrow(/not unlocked/);
    expect(() => game.startBattle(1, "encounter")).toThrow(/locked/);

    for (let i = 0; i < step.winsNeeded; i++) expect((await fight(game, 0, "encounter", "right")).state).toBe("won");
    const end = await fight(game, 0, "boss", "right");
    expect(end.state).toBe("won");
    expect(end.moduleResult).toMatchObject({ passed: true, scaled: 1 });
    expect(end.outro?.story_id).toBe(step.step.outro);
    expect(game.steps().map((s) => s.status)).toEqual(["cleared", "open", "locked"]);

    await game.sync();
    const verbs = h.delivered.map((s) => s.verb.id.split("/").pop());
    expect(verbs[0]).toBe("launched");
    expect(verbs).toContain("answered");
    expect(verbs.filter((v) => v === "defeated")).toHaveLength(step.winsNeeded + 1);
    expect(verbs).toContain("passed");
    for (const s of h.delivered) expect(validateStatement(s).ok, JSON.stringify(validateStatement(s))).toBe(true);
    expect(h.delivered.every((s) => s.actor.account.homePage === BASE && s.actor.account.name === "guest_0000abcd")).toBe(true);
    const answered = h.delivered.find((s) => s.verb.id.endsWith("answered"))!;
    expect(answered.context?.extensions?.[`${BASE}/xapi/ext/game-context`]).toMatchObject({ scene: "battle", mode: "quest", track: "main_a1" });
    const need = Math.ceil(step.module.mastery.boss_task_count * step.module.mastery.pass_score);
    expect(h.reported).toEqual([{ module_id: step.module.module_id, correct: need, total: need }]);
  });

  it("a lost boss fight records a failed result and keeps the step open", async () => {
    const h = deps();
    const game = await Game.load(h.deps);
    for (let i = 0; i < game.steps()[0]!.winsNeeded; i++) await fight(game, 0, "encounter", "right");
    const end = await fight(game, 0, "boss", "wrong");
    expect(end).toMatchObject({ state: "lost", moduleResult: { passed: false } });
    expect(end.outro).toBeUndefined();
    expect(game.steps()[0]!.status).toBe("boss_ready");
    await game.sync();
    expect(h.delivered.some((s) => s.verb.id.endsWith("failed"))).toBe(true);
  });

  it("keeps statements and results while offline and delivers them once online", async () => {
    const h = deps();
    h.setOnline(false);
    const game = await Game.load(h.deps);
    for (let i = 0; i < game.steps()[0]!.winsNeeded; i++) await fight(game, 0, "encounter", "right");
    await fight(game, 0, "boss", "right");
    const offline = await game.sync();
    expect(offline.pendingResults).toBe(1);
    expect(offline.pendingStatements).toBeGreaterThan(10);
    expect(h.delivered).toHaveLength(0);

    h.setOnline(true);
    // The outbox backs off after a failed send; a later flush (here: a new outbox clock) delivers everything.
    const later = await Game.load({ ...h.deps, outboxStore: h.deps.outboxStore });
    (later.outbox as any).o.now = () => Date.now() + 60 * 60_000;
    expect(await later.sync()).toEqual({ pendingStatements: 0, pendingResults: 0 });
    expect(new Set(h.delivered.map((s) => s.id)).size).toBe(h.delivered.length);
    expect(h.reported).toHaveLength(1);
  });

  it("restores progress, FSRS cards and the journal after a reload (IndexedDB)", async () => {
    const db = await openPlayerDb("guest_reload01");
    const stores = { kv: new IdbKeyValue(db), journal: new IdbJournal(db), outboxStore: new IdbOutboxStore(db) };
    const h = deps(stores);
    const game = await Game.load(h.deps);
    await fight(game, 0, "encounter", "right");
    await game.sync();
    const answered = (await stores.journal.all()).length;
    expect(answered).toBeGreaterThan(0);

    const reloaded = await Game.load(deps(stores).deps);
    expect(reloaded.progress.modules.A1_VerbToBe_01?.wins).toBe(1);
    expect(reloaded.scheduler.toJSON().length).toBeGreaterThan(0);
    expect(await stores.outboxStore.pendingCount()).toBe(0);
    db.close();
  });

  it("shows a story once", async () => {
    const game = await Game.load(deps().deps);
    expect((await game.storyOnce("ch1_intro"))?.lines.length).toBeGreaterThan(0);
    expect(await game.storyOnce("ch1_intro")).toBeUndefined();
  });
});
