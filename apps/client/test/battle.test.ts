import type { ContentBundle, Module, Task } from "@knight/content";
import { checkAnswer } from "@knight/learning";
import { beforeAll, describe, expect, it } from "vitest";
import { Battle } from "../src/game/battle.js";
import { answerFor, loadBundle } from "./fixtures.js";

let bundle: ContentBundle;
let tasks: Map<string, Task>;
let module: Module;
beforeAll(async () => {
  bundle = await loadBundle();
  tasks = new Map(Object.entries(bundle.tasks));
  module = bundle.modules.find((m) => m.module_id === "A1_PastSimple_01")!;
});

const enemy = (id: string) => bundle.enemies.find((e) => e.enemy_id === id)!;
const play = (b: Battle, kind: "right" | "wrong") => {
  const task = b.nextTask();
  return b.resolve(task, checkAnswer(task, answerFor(task, kind)));
};

describe("Battle: encounter", () => {
  it("a correct answer hurts the enemy by the task's damage, an error hurts the knight by the enemy's damage", () => {
    const b = new Battle({ kind: "encounter", enemy: enemy("ash_imp"), module, tasks, random: () => 0 });
    const hit = play(b, "right");
    expect(hit.kind).toBe("hit");
    expect(b.enemyHp).toBe(enemy("ash_imp").hp - hit.enemyDamage);
    const miss = play(b, "wrong");
    expect(miss).toMatchObject({ kind: "miss", enemyDamage: 0, knightDamage: enemy("ash_imp").damage });
  });

  it("a typo grazes: half damage to the enemy, none to the knight", () => {
    const b = new Battle({ kind: "encounter", enemy: enemy("ash_imp"), module, tasks, random: () => 0 });
    const task = tasks.get("A1_PastSimple_01_q3")!; // went
    const strike = b.resolve(task, checkAnswer(task, "wnet"));
    expect(strike).toEqual({ kind: "graze", enemyDamage: Math.floor((task.combat?.damage ?? 10) / 2), knightDamage: 0 });
  });

  it("ends in victory or retreat", () => {
    const won = new Battle({ kind: "encounter", enemy: enemy("ash_imp"), module, tasks });
    while (won.state === "ongoing") play(won, "right");
    expect(won.state).toBe("won");
    const lost = new Battle({ kind: "encounter", enemy: enemy("ash_imp"), module, tasks });
    while (lost.state === "ongoing") play(lost, "wrong");
    expect(lost.state).toBe("lost");
    expect(() => play(lost, "right")).toThrow(/over/);
  });

  it("rotates concepts and does not repeat a task until the module pool is used up", () => {
    const b = new Battle({ kind: "encounter", enemy: { ...enemy("ash_imp"), hp: 10_000 }, module, tasks, knightMaxHp: 10_000 });
    const asked = Array.from({ length: module.tasks.length }, () => b.nextTask());
    expect(new Set(asked.map((t) => t.task_id)).size).toBe(module.tasks.length);
    const firstThree = asked.slice(0, 3).map((t) => t.concept_id);
    expect(new Set(firstThree).size).toBe(module.concepts.length);
    expect(module.tasks).toContain(b.nextTask().task_id);
  });
});

describe("Battle: boss", () => {
  it("is won exactly when the share of correct answers reaches pass_score", () => {
    // boss_task_count 10, pass_score 0.8 → 8 correct needed, 2 errors allowed
    const b = new Battle({ kind: "boss", enemy: enemy("ash_golem"), module, tasks });
    expect([b.need, b.allowedWrong]).toEqual([8, 2]);
    play(b, "wrong");
    play(b, "wrong");
    for (let i = 0; i < 7; i++) play(b, "right");
    expect(b.state).toBe("ongoing");
    expect(b.enemyHp).toBeGreaterThan(0);
    play(b, "right");
    expect(b.state).toBe("won");
    expect(b.enemyHp).toBe(0);
    expect(b.correct / b.answered).toBeGreaterThanOrEqual(module.mastery.pass_score);
  });

  it("the knight retreats once pass_score can no longer be reached", () => {
    const b = new Battle({ kind: "boss", enemy: enemy("ash_golem"), module, tasks });
    for (let i = 0; i < 7; i++) play(b, "right");
    play(b, "wrong");
    play(b, "wrong");
    expect(b.state).toBe("ongoing");
    expect(b.knightHp).toBeGreaterThan(0);
    play(b, "wrong");
    expect(b.state).toBe("lost");
    expect(b.knightHp).toBe(0);
    expect(b.correct / b.answered).toBeLessThan(module.mastery.pass_score);
  });

  it("follows the module's mastery settings from content", () => {
    const strict = { ...module, mastery: { boss_task_count: 5, pass_score: 1 } };
    const b = new Battle({ kind: "boss", enemy: enemy("ash_golem"), module: strict, tasks });
    expect([b.need, b.allowedWrong]).toEqual([5, 0]);
    play(b, "wrong");
    expect(b.state).toBe("lost");
  });
});

describe("Battle: patrol and repair", () => {
  it("asks the scripted tasks in order and cannot be lost", () => {
    const script = module.tasks.slice(0, 4).map((id) => tasks.get(id)!);
    const b = new Battle({ kind: "patrol", enemy: enemy("gate_rat"), script, knightMaxHp: 40 });
    const asked: string[] = [];
    while (b.state === "ongoing") {
      const task = b.nextTask();
      asked.push(task.task_id);
      b.resolve(task, checkAnswer(task, answerFor(task, "wrong")));
      expect(b.knightHp).toBeGreaterThan(0);
    }
    expect(asked).toEqual(script.map((t) => t.task_id));
    expect(b.state).toBe("won");
    expect(b.enemyHp).toBe(0);
    expect(b.wrong).toBe(4);
  });

  it("needs tasks", () => {
    expect(() => new Battle({ kind: "repair", enemy: enemy("gate_rat"), script: [] })).toThrow(/needs tasks/);
  });

  it("counts hints", () => {
    const b = new Battle({ kind: "encounter", enemy: enemy("ash_imp"), module, tasks, hints: 1 });
    expect(b.spendHint()).toBe(true);
    expect(b.spendHint()).toBe(false);
    expect(b.hintsLeft).toBe(0);
    expect(new Battle({ kind: "encounter", enemy: enemy("ash_imp"), module, tasks }).hintsLeft).toBe(Infinity);
  });
});
