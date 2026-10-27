import type { ContentBundle } from "@moonbridge/content";
import { MemoryOutboxStore, Outbox, validateStatement, type Statement } from "@moonbridge/xapi";
import { beforeAll, describe, expect, it } from "vitest";
import { buildPatrol, ConceptScheduler, errorStats, LearningEngine, MemoryJournal, Rating } from "../src/index.js";
import { loadBundle } from "./fixtures.js";

let bundle: ContentBundle;
beforeAll(async () => {
  bundle = await loadBundle();
});

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function setup(start = new Date("2026-10-26T08:00:00Z")) {
  let now = start;
  const queued: Statement[] = [];
  const scheduler = new ConceptScheduler({ enableFuzz: false });
  const journal = new MemoryJournal();
  const engine = new LearningEngine({
    bundle,
    playerId: "player_test",
    scheduler,
    journal,
    queue: { enqueue: async (s) => queued.push(...s) },
    registration: "2b9e7c41-3f0a-4d8e-b6a2-91c4e5d7f803",
    now: () => now,
  });
  return { engine, scheduler, journal, queued, advance: (ms: number) => (now = new Date(now.getTime() + ms)), now: () => now };
}

describe("ConceptScheduler", () => {
  it("brings a concept back within a day after an error, and later after a correct answer", () => {
    const now = new Date("2026-10-26T08:00:00Z");
    const s = new ConceptScheduler({ enableFuzz: false });
    s.review("a.wrong", Rating.Again, now);
    s.review("a.right", Rating.Good, now);
    s.review("a.right", Rating.Good, new Date(now.getTime() + 15 * 60_000));
    const wrongDue = s.card("a.wrong").due.getTime() - now.getTime();
    const rightDue = s.card("a.right").due.getTime() - now.getTime();
    expect(wrongDue).toBeLessThanOrEqual(DAY);
    expect(rightDue).toBeGreaterThan(wrongDue);
  });

  it("survives a JSON round trip", () => {
    const now = new Date("2026-10-26T08:00:00Z");
    const s = new ConceptScheduler({ enableFuzz: false });
    s.review("x.y", Rating.Good, now);
    const restored = new ConceptScheduler({ enableFuzz: false }, JSON.parse(JSON.stringify(s.toJSON())));
    expect(restored.card("x.y").due.getTime()).toBe(s.card("x.y").due.getTime());
    expect(restored.retrievability("x.y", new Date(now.getTime() + 5 * DAY))).toBeCloseTo(s.retrievability("x.y", new Date(now.getTime() + 5 * DAY))!);
    expect(s.toJSON()[0]!.scheduler.fsrs_version).toBeTruthy();
  });

  it("marks a building as needing repair once its concepts fade", () => {
    const now = new Date("2026-10-26T08:00:00Z");
    const s = new ConceptScheduler({ enableFuzz: false });
    s.review("c.one", Rating.Good, now);
    expect(s.needsRepair(["c.one", "c.never_studied"], now)).toBe(false);
    expect(s.needsRepair(["c.one"], new Date(now.getTime() + 60 * DAY))).toBe(true);
  });
});

describe("LearningEngine", () => {
  it("turns an attempt into a journal entry and a valid xAPI statement with the same id", async () => {
    const { engine, journal, queued } = setup();
    const r = await engine.submit({ taskId: "A1_PastSimple_01_q3", response: "goed", durationMs: 8400, gameContext: { scene: "battle", enemy: "ash_imp" } });

    expect(r.outcome.errorType).toBe("grammar.overgeneralization");
    expect(r.rating).toBe(Rating.Again);
    expect((await journal.all())[0]).toMatchObject({ task_id: "A1_PastSimple_01_q3", concept_id: "past_simple.irregular", content_version: "A1_PastSimple_01@1" });

    const st = queued[0]!;
    expect(validateStatement(st)).toEqual({ ok: true, statement: st });
    expect(st.id).toBe(r.attempt.attempt_id);
    expect(st.actor.account).toEqual({ homePage: "https://moonbridge.example.com", name: "player_test" });
    expect(st.verb.id).toBe("http://adlnet.gov/expapi/verbs/answered");
    expect(st.result).toMatchObject({
      success: false,
      response: "goed",
      duration: "PT8.4S",
      extensions: {
        "https://moonbridge.example.com/xapi/ext/error-type": "https://moonbridge.example.com/xapi/errors/grammar/overgeneralization",
        "https://moonbridge.example.com/xapi/ext/correct-form": "went",
      },
    });
    expect(st.context?.contextActivities?.grouping?.[0]?.id).toBe("https://moonbridge.example.com/xapi/concepts/past_simple.irregular");
    expect(engine.answeredStatement(r.attempt)).toEqual(st);
  });

  it("builds error stats from the same attempts", async () => {
    const { engine, journal } = setup();
    await engine.submit({ taskId: "A1_PastSimple_01_q3", response: "goed", durationMs: 5000 });
    await engine.submit({ taskId: "A1_PastSimple_01_q4", response: "seed", durationMs: 5000 });
    await engine.submit({ taskId: "A1_PastSimple_01_q3", response: "flyed", durationMs: 5000 });
    await engine.submit({ taskId: "A1_PastSimple_01_q1", response: "walked", durationMs: 5000 });
    const stats = errorStats(await journal.all());
    expect(stats.total).toBe(4);
    expect(stats.topErrorTypes[0]).toEqual({ error_type: "grammar.overgeneralization", count: 2 });
    expect(stats.unclassified).toEqual([{ task_id: "A1_PastSimple_01_q3", response: "flyed", count: 1 }]);
    expect(stats.byConcept["past_simple.irregular"]).toEqual({ attempts: 3, errors: 3 });
  });

  it("passes the boss at pass_score and emits passed/failed with a score", async () => {
    const { engine, queued } = setup();
    const win = await engine.moduleResult({ moduleId: "A1_PastSimple_01", correct: 8, total: 10, trackId: "main_a1" });
    const loss = await engine.moduleResult({ moduleId: "A1_PastSimple_01", correct: 7, total: 10 });
    expect(win.passed).toBe(true);
    expect(loss.passed).toBe(false);
    expect(queued.map((s) => s.verb.id)).toEqual(["http://adlnet.gov/expapi/verbs/passed", "http://adlnet.gov/expapi/verbs/failed"]);
    expect(queued[0]!.result?.score).toEqual({ raw: 8, min: 0, max: 10, scaled: 0.8 });
    for (const s of queued) expect(validateStatement(s).ok).toBe(true);
  });

  it("feeds statements into an outbox", async () => {
    const sent: Statement[] = [];
    const outbox = new Outbox(new MemoryOutboxStore(), { send: async (b) => (sent.push(...b), { kind: "sent", ids: b.map((s) => s.id) }) });
    const engine = new LearningEngine({ bundle, playerId: "p1", scheduler: new ConceptScheduler(), journal: new MemoryJournal(), queue: outbox });
    await engine.submit({ taskId: "A1_Articles_01_q1", response: "an", durationMs: 2000 });
    await outbox.flush();
    expect(sent).toHaveLength(1);
  });
});

describe("buildPatrol", () => {
  it("is empty before anything was studied, then picks due concepts without repeating tasks", async () => {
    const { engine, scheduler, advance, now } = setup();
    const modules = ["A1_VerbToBe_01", "A1_PastSimple_01"];
    expect(buildPatrol(bundle, scheduler, { moduleIds: modules, lastSeen: new Map(), now: now() })).toEqual([]);

    await engine.submit({ taskId: "A1_PastSimple_01_q3", response: "goed", durationMs: 5000 });
    await engine.submit({ taskId: "A1_VerbToBe_01_q1", response: "am", durationMs: 5000 });
    advance(2 * DAY);

    const lastSeen = new Map([["A1_PastSimple_01_q3", now().getTime() - 2 * DAY]]);
    const patrol = buildPatrol(bundle, scheduler, { moduleIds: modules, lastSeen, now: now(), size: 6, random: () => 0 });
    expect(patrol).toHaveLength(6);
    expect(new Set(patrol.map((t) => t.task_id)).size).toBe(6);
    expect(patrol[0]!.concept_id).toBe("past_simple.irregular"); // the failed concept is the weakest
    expect(patrol.map((t) => t.task_id)).not.toContain("A1_PastSimple_01_q3"); // seen 2 days ago, cooldown is 3
    expect(new Set(patrol.map((t) => t.concept_id))).toEqual(new Set(["past_simple.irregular", "verb_to_be.present_forms"]));
  });
});
