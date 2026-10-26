import type { Enemy, Module, Task } from "@knight/content";
import { pickTask, type CheckOutcome } from "@knight/learning";

export const KNIGHT_BASE_HP = 30;
/** Damage of a correct answer when the task has no combat.damage. */
export const DEFAULT_TASK_DAMAGE = 10;

/** encounter and boss belong to a track step; patrol and repair are scripted review sessions from FSRS. */
export type BattleKind = "encounter" | "boss" | "patrol" | "repair";
export type BattleState = "ongoing" | "won" | "lost";

export interface Strike {
  /** hit: correct answer; graze: a typo (right grammar, so the knight is not hurt); miss: an error. */
  kind: "hit" | "graze" | "miss";
  enemyDamage: number;
  knightDamage: number;
}

export interface BattleSetup {
  kind: BattleKind;
  enemy: Enemy;
  /** The step's module, for encounter and boss. */
  module?: Module;
  /** Active tasks of the module, by id (encounter and boss). */
  tasks?: Map<string, Task>;
  /** Patrol and repair: the exact tasks to ask, in order. */
  script?: Task[];
  knightMaxHp?: number;
  /** Hints the knight may open in this battle. Unlimited when undefined. */
  hints?: number;
  /** When each task was last answered, epoch ms; fresh tasks are preferred. */
  lastSeen?: Map<string, number>;
  now?: number;
  random?: () => number;
}

/**
 * One battle, as pure rules: which task comes next and what an answer does.
 * Knows task ids and concepts, never task text, and draws nothing.
 *
 * An encounter is HP against HP. Patrol and repair are a fixed list of review
 * tasks: the "enemy" falls as the list is worked through and the knight cannot
 * lose, because a review session is practice, not a test.
 * A boss fight is the module's final check:
 * it is won once `ceil(boss_task_count × pass_score)` answers are correct and
 * lost once that is no longer reachable. The HP bars show exactly that, so the
 * boss falls if and only if the share of correct answers reaches pass_score.
 */
export class Battle {
  readonly id: string;
  readonly kind: BattleKind;
  readonly enemy: Enemy;
  readonly module: Module | undefined;
  readonly script: Task[] | undefined;
  readonly knightMaxHp: number;
  readonly enemyMaxHp: number;
  /** Boss fight: correct answers needed and wrong answers allowed. */
  readonly need: number;
  readonly allowedWrong: number;

  correct = 0;
  wrong = 0;
  hintsLeft: number;
  private knightLost = 0;
  private enemyLost = 0;
  private readonly used = new Set<string>();
  private readonly byConcept: Map<string, Task[]>;
  private conceptCursor: number;
  private readonly random: () => number;

  constructor(private readonly s: BattleSetup) {
    this.id = crypto.randomUUID();
    this.kind = s.kind;
    this.enemy = s.enemy;
    this.module = s.module;
    this.script = s.script;
    this.knightMaxHp = s.knightMaxHp ?? KNIGHT_BASE_HP;
    this.enemyMaxHp = s.enemy.hp;
    this.hintsLeft = s.hints ?? Infinity;
    this.random = s.random ?? Math.random;
    this.byConcept = new Map();
    this.conceptCursor = 0;

    if (s.kind === "patrol" || s.kind === "repair") {
      if (!s.script?.length) throw new Error(`a ${s.kind} needs tasks`);
      this.need = s.script.length;
      this.allowedWrong = s.script.length;
      return;
    }
    const module = s.module;
    if (!module) throw new Error(`a ${s.kind} battle needs a module`);
    const total = module.mastery.boss_task_count;
    this.need = Math.max(1, Math.ceil(total * module.mastery.pass_score - 1e-9));
    this.allowedWrong = Math.max(0, total - this.need);

    this.byConcept = new Map(module.concepts.map((c) => [c.concept_id, [] as Task[]]));
    for (const id of module.tasks) {
      const t = s.tasks?.get(id);
      if (t) this.byConcept.get(t.concept_id)?.push(t);
    }
    if (![...this.byConcept.values()].some((l) => l.length)) throw new Error(`module ${module.module_id} has no active tasks`);
    this.conceptCursor = Math.floor(this.random() * module.concepts.length);
  }

  get scripted(): boolean {
    return this.script !== undefined;
  }

  /** Spends a hint; false when none are left. */
  spendHint(): boolean {
    if (this.hintsLeft <= 0) return false;
    this.hintsLeft--;
    return true;
  }

  get answered(): number {
    return this.correct + this.wrong;
  }

  get knightHp(): number {
    // A review session shows mistakes on the bar but never knocks the knight out.
    if (this.script) return Math.max(0, this.knightMaxHp * (1 - this.wrong / (this.script.length + 1)));
    if (this.kind === "boss") return Math.max(0, this.knightMaxHp * (1 - this.wrong / (this.allowedWrong + 1)));
    return Math.max(0, this.knightMaxHp - this.knightLost);
  }

  get enemyHp(): number {
    if (this.script) return Math.max(0, this.enemyMaxHp * (1 - this.answered / this.script.length));
    if (this.kind === "boss") return Math.max(0, this.enemyMaxHp * (1 - this.correct / this.need));
    return Math.max(0, this.enemyMaxHp - this.enemyLost);
  }

  get state(): BattleState {
    if (this.script) return this.answered >= this.script.length ? "won" : "ongoing";
    if (this.kind === "boss") {
      if (this.correct >= this.need) return "won";
      if (this.wrong > this.allowedWrong) return "lost";
      return "ongoing";
    }
    if (this.enemyHp <= 0) return "won";
    if (this.knightHp <= 0) return "lost";
    return "ongoing";
  }

  /** Next task: concepts take turns so one battle covers the whole module; within a concept, fresh tasks first. */
  nextTask(): Task {
    if (this.script) {
      const task = this.script[this.answered];
      if (!task) throw new Error("the review is over");
      return task;
    }
    const concepts = this.module!.concepts;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < concepts.length; i++) {
        const concept = concepts[(this.conceptCursor + i) % concepts.length]!;
        const task = pickTask(this.byConcept.get(concept.concept_id) ?? [], {
          lastSeen: this.s.lastSeen ?? new Map(),
          now: this.s.now ?? Date.now(),
          exclude: this.used,
          random: this.random,
        });
        if (!task) continue;
        this.conceptCursor = (this.conceptCursor + i + 1) % concepts.length;
        this.used.add(task.task_id);
        return task;
      }
      // Every task of the module has been asked in this battle: start over.
      this.used.clear();
    }
    throw new Error("unreachable: module has tasks");
  }

  /** Applies a checked answer to the battle. */
  resolve(task: Task, outcome: CheckOutcome): Strike {
    if (this.state !== "ongoing") throw new Error("the battle is over");
    const kind: Strike["kind"] = outcome.correct ? "hit" : outcome.match === "typo" ? "graze" : "miss";
    const before = { knight: this.knightHp, enemy: this.enemyHp };
    if (this.kind === "boss" || this.script) {
      // The boss fight is the module's score, and a typo is not a correct answer there;
      // in a review the bars only count answers, so they follow the same rule.
      if (outcome.correct) this.correct++;
      else this.wrong++;
    } else {
      const damage = task.combat?.damage ?? DEFAULT_TASK_DAMAGE;
      if (kind === "hit") this.enemyLost += damage;
      else if (kind === "graze") this.enemyLost += Math.floor(damage / 2);
      else this.knightLost += this.enemy.damage;
      if (outcome.correct) this.correct++;
      else this.wrong++;
    }
    return { kind, enemyDamage: before.enemy - this.enemyHp, knightDamage: before.knight - this.knightHp };
  }
}
