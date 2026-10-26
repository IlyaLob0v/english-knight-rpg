import type { ContentBundle } from "@knight/content";
import { MemoryJournal } from "@knight/learning";
import { MemoryOutboxStore, validateStatement, type Statement, type StatementSink } from "@knight/xapi";
import { beforeAll, describe, expect, it } from "vitest";
import type { Battle } from "../src/game/battle.js";
import { Game } from "../src/game/game.js";
import { emptyProgress, migrateProgress } from "../src/game/progress.js";
import { levelOf, localDay } from "../src/game/rules.js";
import { MemoryKeyValue } from "../src/storage/idb.js";
import { answerFor, loadBundle } from "./fixtures.js";

let bundle: ContentBundle;
beforeAll(async () => {
  bundle = await loadBundle();
});

const BASE = "https://knight.test";
const DAY = 24 * 60 * 60 * 1000;

async function setup(b: ContentBundle = bundle) {
  const delivered: Statement[] = [];
  const sink: StatementSink = { send: async (s) => (delivered.push(...s), { kind: "sent", ids: s.map((x) => x.id) }) };
  const clock = { t: new Date("2026-10-26T09:00:00").getTime() };
  const journal = new MemoryJournal();
  const game = await Game.load({
    bundle: b,
    playerId: "guest_0000c1ty",
    registration: "2b9e7c41-3f0a-4d8e-b6a2-91c4e5d7f803",
    xapiBaseIri: BASE,
    kv: new MemoryKeyValue(),
    journal,
    outboxStore: new MemoryOutboxStore(),
    sink,
    now: () => new Date(clock.t),
    random: () => 0,
  });
  return { game, delivered, clock, journal };
}

async function play(game: Game, battle: Battle, answer: "right" | "wrong" | ((i: number) => "right" | "wrong")) {
  for (let i = 0; battle.state === "ongoing"; i++) {
    const task = battle.nextTask();
    await game.answer(battle, task, { response: answerFor(task, typeof answer === "function" ? answer(i) : answer), hintUsed: false, durationMs: 4000 });
  }
  return game.finishBattle(battle);
}

async function clearStep(game: Game, step: number) {
  for (let i = 0; i < game.steps()[step]!.winsNeeded; i++) await play(game, game.startBattle(step, "encounter"), "right");
  return play(game, game.startBattle(step, "boss"), "right");
}

const verbs = (s: Statement[]) => s.map((x) => x.verb.id.split("/").pop());

describe("city", () => {
  it("a boss victory opens the building the track names; KP build it", async () => {
    const { game, delivered } = await setup();
    const rules = game.rules;
    expect(game.city().map((v) => v.state)).toEqual(["locked", "locked", "locked"]);

    const end = await clearStep(game, 0);
    const townHall = game.track.chapters[0]!.steps[0]!.unlocks_building;
    expect(end.unlockedBuilding?.building_id).toBe(townHall);
    expect(game.city()[0]).toMatchObject({ state: "site", building: { building_id: townHall } });

    const encounterKp = (rules.rewards.encounter_won.kp ?? 0) * game.steps()[0]!.winsNeeded;
    expect(game.progress.kp).toBe(encounterKp + (rules.rewards.boss_passed.kp ?? 0));
    const kpBefore = game.progress.kp;
    await game.build(townHall);
    expect(game.city()[0]!.state).toBe("built");
    expect(game.progress.kp).toBe(kpBefore - game.city()[0]!.building.cost_kp);
    await expect(game.build(townHall)).rejects.toThrow(/cannot be built/);
    await expect(game.build(game.city()[1]!.building.building_id)).rejects.toThrow(/cannot be built/);

    await game.sync();
    const built = delivered.filter((s) => s.verb.id.endsWith("/built"));
    expect(built).toHaveLength(1);
    expect(built[0]!.object.id).toBe(`${BASE}/xapi/buildings/${townHall}`);
    for (const s of delivered) expect(validateStatement(s).ok).toBe(true);
  });

  it("follows the track: giving the forge to the first module puts it on the first plot", async () => {
    const b = structuredClone(bundle);
    const steps = b.tracks[0]!.chapters[0]!.steps;
    [steps[0]!.unlocks_building, steps[1]!.unlocks_building] = [steps[1]!.unlocks_building, steps[0]!.unlocks_building];
    const { game } = await setup(b);
    const end = await clearStep(game, 0);
    expect(end.unlockedBuilding?.building_id).toBe("forge");
    expect(game.city()[0]!.building.building_id).toBe("forge");
  });

  it("XP from answers and victories raises the level; whole buildings give their bonus", async () => {
    const { game } = await setup();
    expect(game.hud()).toMatchObject({ level: 1, xp: 0, maxHp: game.rules.knight.base_hp });
    const first = await play(game, game.startBattle(0, "encounter"), "right");
    expect(first.earned.xp).toBeGreaterThan(game.rules.rewards.encounter_won.xp!);
    await clearStep(game, 0);
    const level = levelOf(game.progress.xp, game.rules).level;
    expect(level).toBeGreaterThan(1);
    const hpBefore = game.hud().maxHp;
    await game.build(game.city()[0]!.building.building_id);
    const bonus = game.city()[0]!.building.bonus!;
    expect(bonus.kind).toBe("max_hp");
    expect(game.hud().maxHp).toBe(hpBefore + bonus.value);
    expect(game.startBattle(1, "encounter").knightMaxHp).toBe(hpBefore + bonus.value);
  });
});

describe("daily patrol", () => {
  it("is built from practised concepts, rewards once a day and is tagged daily_patrol in xAPI", async () => {
    const { game, delivered, clock } = await setup();
    expect(game.patrolStatus().studiedConcepts).toBe(0);
    expect(() => game.startPatrol()).toThrow(/nothing to patrol/);
    await clearStep(game, 0);

    clock.t += 3 * DAY;
    const status = game.patrolStatus();
    expect(status.studiedConcepts).toBe(game.steps()[0]!.module.concepts.length);
    expect(status.dueConcepts).toBeGreaterThan(0);
    const patrol = game.startPatrol();
    const ids = patrol.script!.map((t) => t.task_id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(game.rules.patrol.size);
    expect(new Set(ids).size).toBe(ids.length);
    const allowed = new Set(game.steps()[0]!.module.tasks);
    expect(ids.every((id) => allowed.has(id))).toBe(true);

    const kp = game.progress.kp;
    const end = await play(game, patrol, "right");
    expect(end).toMatchObject({ state: "won", patrolRewarded: true });
    expect(game.progress.kp).toBe(kp + (game.rules.rewards.patrol_completed.kp ?? 0));
    expect(game.patrolStatus()).toMatchObject({ doneToday: true, daysThisWeek: 1, streak: 1 });
    expect(game.progress.patrolDays).toEqual([localDay(new Date(clock.t))]);

    const again = await play(game, game.startPatrol(), "right");
    expect(again.patrolRewarded).toBe(false);
    expect(game.progress.patrolDays).toHaveLength(1);

    await game.sync();
    const modes = delivered
      .filter((s) => s.verb.id.endsWith("answered"))
      .map((s) => (s.context?.extensions?.[`${BASE}/xapi/ext/game-context`] as { mode: string }).mode);
    expect(modes).toContain("daily_patrol");
  });

  it("does not repeat a task within the cooldown while its concept has other tasks", async () => {
    const b = structuredClone(bundle);
    b.progression!.patrol.size = 3;
    const { game, clock } = await setup(b);
    await clearStep(game, 0);
    clock.t += 3 * DAY;
    const patrol = game.startPatrol();
    const first = patrol.script!.map((t) => t.task_id);
    await play(game, patrol, "right");
    clock.t += DAY;
    // A day later the tasks just answered are on cooldown: the next patrol takes the others.
    const next = game.startPatrol().script!.map((t) => t.task_id);
    expect(first).toHaveLength(3);
    expect(next).toHaveLength(3);
    expect(next.filter((id) => first.includes(id))).toEqual([]);
  });

  it("counts a streak of consecutive days", async () => {
    const { game, clock } = await setup();
    await clearStep(game, 0);
    for (let d = 0; d < 3; d++) {
      clock.t += DAY;
      await play(game, game.startPatrol(), "right");
    }
    expect(game.patrolStatus()).toMatchObject({ streak: 3, daysThisWeek: 3 });
    clock.t += 2 * DAY;
    expect(game.patrolStatus()).toMatchObject({ streak: 0, doneToday: false });
  });
});

describe("repair", () => {
  it("a building cracks when its concepts fade, loses its bonus, and review repairs it", async () => {
    const { game, delivered, clock } = await setup();
    await clearStep(game, 0);
    const id = game.city()[0]!.building.building_id;
    await game.build(id);
    const hpWhole = game.hud().maxHp;
    await expect(game.startRepair(id)).rejects.toThrow(/does not need repair/);

    clock.t += 60 * DAY;
    expect(game.city()[0]!.state).toBe("damaged");
    expect(game.city()[0]!.concepts.some((c) => c.weak)).toBe(true);
    expect(game.hud().maxHp).toBe(hpWhole - game.city()[0]!.building.bonus!.value);

    const repair = await game.startRepair(id);
    expect(game.repairTarget(repair)?.building_id).toBe(id);
    expect(repair.script!.length).toBeLessThanOrEqual(game.rules.repair.task_count);
    const kp = game.progress.kp;
    const end = await play(game, repair, "right");
    expect(end.repaired.map((b) => b.building_id)).toEqual([id]);
    expect(game.city()[0]!.state).toBe("built");
    expect(game.hud().maxHp).toBe(hpWhole);
    expect(game.progress.kp).toBe(kp + (game.rules.rewards.building_repaired.kp ?? 0));
    expect(game.progress.buildings[id]).toMatchObject({ damaged: false, repairs: 1 });

    await game.sync();
    const repaired = delivered.filter((s) => s.verb.id.endsWith("/repaired"));
    expect(repaired).toHaveLength(1);
    expect(validateStatement(repaired[0]!).ok).toBe(true);
    const repairModes = delivered
      .filter((s) => (s.context?.extensions?.[`${BASE}/xapi/ext/game-context`] as { mode?: string } | undefined)?.mode === "repair")
      .map((s) => (s.context!.extensions![`${BASE}/xapi/ext/game-context`] as { building: string }).building);
    expect(new Set(repairModes)).toEqual(new Set([id]));
  });

  it("wrong answers leave the cracks", async () => {
    const { game, clock } = await setup();
    await clearStep(game, 0);
    const id = game.city()[0]!.building.building_id;
    await game.build(id);
    clock.t += 60 * DAY;
    const end = await play(game, await game.startRepair(id), "wrong");
    expect(end.state).toBe("won");
    expect(end.repaired).toEqual([]);
    expect(game.city()[0]!.state).toBe("damaged");
  });
});

describe("error statistics", () => {
  it("are built from the same records that go to xAPI", async () => {
    const { game, delivered } = await setup();
    await play(game, game.startBattle(0, "encounter"), (i) => (i % 2 ? "wrong" : "right"));
    await play(game, game.startBattle(0, "encounter"), "right");
    await game.sync();

    const report = await game.errorReport();
    const answered = delivered.filter((s) => s.verb.id.endsWith("answered"));
    expect(report.total).toBe(answered.length);
    expect(report.correct).toBe(answered.filter((s) => s.result?.success).length);

    const fromXapi = new Map<string, number>();
    for (const s of answered) {
      const iri = s.result?.extensions?.[`${BASE}/xapi/ext/error-type`] as string | undefined;
      if (iri) fromXapi.set(iri, (fromXapi.get(iri) ?? 0) + 1);
    }
    expect(new Map(report.topErrorTypes.map((t) => [`${BASE}/xapi/errors/${t.id.split(".").join("/")}`, t.count]))).toEqual(fromXapi);
    expect(report.topErrorTypes.length).toBeLessThanOrEqual(5);
    expect(report.topErrorTypes[0]!.label).toBe(bundle.taxonomy.error_types.find((t) => t.id === report.topErrorTypes[0]!.id)!.label.ru);

    // "zzzz qqqq" is nobody's known error: it lands in the unclassified list with its task.
    expect(report.unclassified.length).toBeGreaterThan(0);
    const u = report.unclassified[0]!;
    expect(bundle.tasks[u.taskId]?.presentation.prompt).toBe(u.prompt);
    expect(report.concepts.reduce((n, c) => n + c.attempts, 0)).toBe(report.total);
  });

  it("can be limited to recent days", async () => {
    const { game, clock } = await setup();
    await play(game, game.startBattle(0, "encounter"), "wrong");
    clock.t += 10 * DAY;
    expect((await game.errorReport(7)).total).toBe(0);
    expect((await game.errorReport()).total).toBeGreaterThan(0);
  });
});

describe("progress migration", () => {
  it("keeps week-3 progress and adds the city", () => {
    const old = { version: 1, modules: { A1_VerbToBe_01: { wins: 2, bossPassed: true, bestScore: 0.9, bossAttempts: 1 } }, seenStories: ["ch1_intro"] };
    const p = migrateProgress(old);
    expect(p).toMatchObject({ ...emptyProgress(), modules: old.modules, seenStories: old.seenStories });
    expect(migrateProgress(undefined)).toEqual(emptyProgress());
  });
});
