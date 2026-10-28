import type { ContentBundle, Course } from "@moonbridge/content";
import { MemoryJournal } from "@moonbridge/learning";
import { MemoryOutboxStore } from "@moonbridge/xapi";
import { beforeAll, describe, expect, it } from "vitest";
import { Learner } from "../src/core/learner.js";
import { MAX_ITEMS, planShift, SHIFT_BUDGET_MS, streakOf, type ShiftInput } from "../src/moonbridge/daily.js";
import { MemoryKeyValue } from "../src/storage/idb.js";
import { loadBundle } from "./fixtures.js";

let bundle: ContentBundle;
let course: Course;
beforeAll(async () => {
  bundle = await loadBundle();
  course = bundle.courses[0]!;
});

const DAY = 24 * 3600_000;
const START = Date.parse("2026-11-09T09:00:00Z"); // 12:00 in Moscow

async function learnerAt(clock: { t: number }) {
  return Learner.load({
    bundle,
    playerId: "player_test",
    registration: "2b9e7c41-3f0a-4d8e-b6a2-91c4e5d7f803",
    xapiBaseIri: "https://moonbridge.test",
    kv: new MemoryKeyValue(),
    journal: new MemoryJournal(),
    outboxStore: new MemoryOutboxStore(),
    sink: { send: async (b) => ({ kind: "sent", ids: b.map((s) => s.id) }) },
    now: () => new Date(clock.t),
  });
}

async function inputFor(learner: Learner, extra: Partial<ShiftInput> = {}): Promise<ShiftInput> {
  const now = learner.now();
  return {
    bundle,
    course,
    studiedUnits: ["A1_VerbToBe_01"],
    due: learner.repeats.due(now),
    day: learner.day(now),
    practiceDays: [],
    ...(await learner.pace()),
    now: now.getTime(),
    ...extra,
  };
}

describe("the daily shift with the clock moved forward", () => {
  it("brings an error of day 0 back to the lost-and-found on days 1, 3 and 7, and then never again", async () => {
    const clock = { t: START };
    const learner = await learnerAt(clock);
    const goed = await learner.answer("A1_PastSimple_01_q3", { response: "goed", hintUsed: false, durationMs: 5000 });
    expect(goed.repeat).toBe("started");

    const seen: number[] = [];
    for (let d = 0; d <= 12; d++) {
      clock.t = START + d * DAY;
      const plan = planShift(await inputFor(learner))!;
      const found = plan.lostAndFound.find((x) => x.repeat.concept_id === "past_simple.irregular");
      if (!found) continue;
      seen.push(d);
      expect(found.task.concept_id).toBe("past_simple.irregular");
      expect(found.item.name.ru).toBeTruthy();
      await learner.answer(found.task.task_id, { response: found.task.answer.accepted[0]!, hintUsed: false, durationMs: 4000 });
    }
    expect(seen).toEqual([1, 3, 7]);
  });

  it("starts over when the returned item is answered wrong", async () => {
    const clock = { t: START };
    const learner = await learnerAt(clock);
    await learner.answer("A1_PastSimple_01_q3", { response: "goed", hintUsed: false, durationMs: 5000 });
    clock.t = START + DAY;
    const plan = planShift(await inputFor(learner))!;
    await learner.answer(plan.lostAndFound[0]!.task.task_id, { response: "zzz", hintUsed: false, durationMs: 4000 });
    clock.t = START + 2 * DAY;
    expect(planShift(await inputFor(learner))!.lostAndFound).toHaveLength(1);
  });
});

describe("planShift", () => {
  const base = (over: Partial<ShiftInput> = {}): ShiftInput => ({
    bundle,
    course,
    studiedUnits: ["A1_VerbToBe_01"],
    due: [],
    day: 20_400,
    practiceDays: [],
    lastSeen: new Map(),
    medians: new Map(),
    now: START,
    ...over,
  });

  it("builds the guest only from units the student has passed", () => {
    for (let day = 20_400; day < 20_410; day++) {
      const plan = planShift(base({ day }))!;
      expect(plan.guest!.tasks.length).toBeGreaterThanOrEqual(2);
      for (const t of plan.guest!.tasks) expect(bundle.tasks[t.task_id]!.module_id).toBe("A1_VerbToBe_01");
    }
    expect(planShift(base({ studiedUnits: [] }))!.guest).toBeUndefined();
  });

  it("is the same plan on every reload of the same day, and announces tomorrow's guest", () => {
    const a = planShift(base())!;
    const b = planShift(base())!;
    expect(a.guest!.tasks.map((t) => t.task_id)).toEqual(b.guest!.tasks.map((t) => t.task_id));
    const tomorrow = planShift(base({ day: 20_401 }))!;
    expect(a.teaser!.guest_id).toBe(tomorrow.guest!.template.guest_id);
    expect(a.guest!.template.guest_id).not.toBe(tomorrow.guest!.template.guest_id);
  });

  it("fits 15 minutes even for a slow student with many errors coming back", () => {
    const concepts = bundle.modules.flatMap((m) => m.concepts.map((c) => c.concept_id));
    const due = Array.from({ length: 30 }, (_, i) => ({
      concept_id: concepts[i % concepts.length]!,
      origin_day: 20_390,
      step: 0,
      task_id: "x",
      error_type: "unclassified",
    }));
    const slow = new Map(concepts.map((c) => [c, 90_000]));
    const plan = planShift(base({ due, medians: slow }))!;
    expect(plan.estimatedMs).toBeLessThanOrEqual(SHIFT_BUDGET_MS);
    expect(plan.lostAndFound.length).toBeLessThanOrEqual(MAX_ITEMS);
    expect(plan.lostAndFound.length).toBeGreaterThan(0);

    const fast = planShift(base({ due, medians: new Map(concepts.map((c) => [c, 8000])) }))!;
    expect(fast.lostAndFound).toHaveLength(MAX_ITEMS);
    const count = fast.guest!.template.task_count ?? 4;
    expect(fast.guest!.tasks).toHaveLength(count);
    expect(new Set([...fast.lostAndFound.map((x) => x.task.task_id), ...fast.guest!.tasks.map((t) => t.task_id)]).size).toBe(MAX_ITEMS + count);
  });

  it("welcomes a student back after a pause", () => {
    expect(planShift(base({ practiceDays: [20_396] }))!.returning).toBe(true);
    expect(planShift(base({ practiceDays: [20_398] }))!.returning).toBe(false);
  });
});

describe("streakOf", () => {
  it("counts practice days and forgives one missed day", () => {
    expect(streakOf([], 10)).toEqual({ days: 0, practicedToday: false, daysAway: undefined });
    expect(streakOf([8, 9, 10], 10)).toEqual({ days: 3, practicedToday: true, daysAway: 0 });
    expect(streakOf([7, 9, 10], 10).days).toBe(3);
    expect(streakOf([5, 6, 9, 10], 10).days).toBe(2);
    expect(streakOf([8, 9], 10)).toEqual({ days: 2, practicedToday: false, daysAway: 1 });
    expect(streakOf([8, 9], 11).days).toBe(2);
    expect(streakOf([8, 9], 12)).toEqual({ days: 0, practicedToday: false, daysAway: 3 });
  });
});
