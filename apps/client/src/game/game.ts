import type { Building, ContentBundle, Enemy, Module, Progression, Reward, Story, Task, Track } from "@knight/content";
import { buildPatrol, ConceptScheduler, LearningEngine, type AttemptJournal, type CheckOutcome, type Response, type StoredConceptCard } from "@knight/learning";
import { KnightProfile, Outbox, StatementBuilder, type OutboxStore, type StatementSink } from "@knight/xapi";
import type { KeyValue } from "../storage/idb.js";
import { Battle, type BattleKind, type Strike } from "./battle.js";
import { cityBonuses, cityView, type BuildingView } from "./city.js";
import { addCurrency, markStorySeen, migrateProgress, recordBossResult, recordEncounterWin, trackView, type PlayerProgress, type StepView } from "./progress.js";
import { levelOf, localDay, rulesOf, scaleReward, type CityBonuses, type LevelView } from "./rules.js";
import { errorReport, type ErrorReport } from "./stats.js";

export interface GameDeps {
  bundle: ContentBundle;
  playerId: string;
  registration: string;
  xapiBaseIri: string;
  kv: KeyValue;
  journal: AttemptJournal;
  outboxStore: OutboxStore;
  sink: StatementSink;
  /** Sends a boss result to the gateway (best score → LTI AGS). Throws when offline; the result is retried later. */
  reportModuleResult?: (r: PendingResult) => Promise<unknown>;
  trackId?: string;
  now?: () => Date;
  random?: () => number;
}

export interface PendingResult {
  module_id: string;
  correct: number;
  total: number;
}

export interface AnswerInput {
  response: Response;
  hintUsed: boolean;
  durationMs: number;
}

export interface AnswerResult {
  outcome: CheckOutcome;
  strike: Strike;
  /** XP the answer earned. */
  xp: number;
}

export interface BattleEnd {
  state: "won" | "lost";
  /** Set for boss fights: the module result as recorded in xAPI and sent to the LMS. */
  moduleResult?: { passed: boolean; scaled: number; correct: number; total: number };
  /** The step's outro story, when a boss was defeated for the first time. */
  outro?: Story;
  /** Everything earned in this battle, answers included. */
  earned: { xp: number; kp: number };
  /** Set when the knight reached a new level. */
  levelUp?: number;
  /** A first boss victory opens this building's site in the city. */
  unlockedBuilding?: Building;
  /** Buildings that stand whole again after this battle. */
  repaired: Building[];
  /** Patrol: false when today's patrol reward had already been taken. */
  patrolRewarded?: boolean;
}

export interface Hud extends LevelView {
  xp: number;
  kp: number;
  maxHp: number;
  bonuses: CityBonuses;
}

export interface PatrolStatus {
  /** Today's patrol is done (its reward taken). */
  doneToday: boolean;
  /** Studied concepts FSRS says are due now. */
  dueConcepts: number;
  /** Studied concepts that could appear at all. */
  studiedConcepts: number;
  /** Patrol days in the last 7 days, today included. */
  daysThisWeek: number;
  /** Consecutive patrol days ending today or yesterday. */
  streak: number;
}

const KEYS = { progress: "progress", cards: "fsrs-cards", pendingResults: "pending-module-results" } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MODE: Record<BattleKind, string> = { encounter: "quest", boss: "boss", patrol: "daily_patrol", repair: "repair" };

/**
 * Everything the scenes need, without Phaser: progress, battles, answers through
 * the learning engine, statements into the outbox. Scenes only draw and ask.
 */
export class Game {
  readonly bundle: ContentBundle;
  readonly track: Track;
  readonly outbox: Outbox;
  readonly scheduler: ConceptScheduler;
  readonly rules: Progression;
  progress: PlayerProgress;
  private readonly engine: LearningEngine;
  private readonly builder: StatementBuilder;
  private readonly tasks: Map<string, Task>;
  private readonly lastSeen = new Map<string, number>();
  private readonly lastCorrect = new Map<string, boolean>();
  private readonly now: () => Date;
  private attemptNo = new Map<string, number>();
  private battleStartedAt = 0;
  private battleXp = 0;
  private battleLevel = 1;
  /** Repair battle → building being repaired. */
  private readonly repairing = new WeakMap<Battle, Building>();

  private constructor(private readonly d: GameDeps, progress: PlayerProgress, cards: StoredConceptCard[]) {
    this.bundle = d.bundle;
    const track = d.trackId ? d.bundle.tracks.find((t) => t.track_id === d.trackId) : d.bundle.tracks[0];
    if (!track) throw new Error(`track ${d.trackId ?? "(first)"} is not in the content bundle`);
    this.track = track;
    this.now = d.now ?? (() => new Date());
    this.progress = progress;
    this.rules = rulesOf(d.bundle);
    this.scheduler = new ConceptScheduler({}, cards);
    this.builder = new StatementBuilder(new KnightProfile(d.xapiBaseIri));
    this.outbox = new Outbox(d.outboxStore, d.sink);
    this.engine = new LearningEngine({
      bundle: d.bundle,
      playerId: d.playerId,
      registration: d.registration,
      scheduler: this.scheduler,
      journal: d.journal,
      queue: this.outbox,
      builder: this.builder,
      now: this.now,
    });
    this.tasks = new Map(Object.entries(d.bundle.tasks));
  }

  static async load(d: GameDeps): Promise<Game> {
    const progress = migrateProgress(await d.kv.get<unknown>(KEYS.progress));
    const cards = (await d.kv.get<StoredConceptCard[]>(KEYS.cards)) ?? [];
    const game = new Game(d, progress, cards);
    for (const a of await d.journal.all()) {
      game.lastSeen.set(a.task_id, Date.parse(a.timestamp));
      game.lastCorrect.set(a.concept_id, a.correct);
    }
    return game;
  }

  /** Records the play session start (xAPI launched). */
  async launched(): Promise<void> {
    await this.outbox.enqueue([this.builder.launched({ ...this.common(), trackId: this.track.track_id })]);
  }

  steps(): StepView[] {
    return trackView(this.bundle, this.track, this.progress);
  }

  story(storyId: string | undefined): Story | undefined {
    return storyId ? this.bundle.stories.find((s) => s.story_id === storyId) : undefined;
  }

  /** The story to show once, or undefined if already seen. Marks it seen. */
  async storyOnce(storyId: string | undefined): Promise<Story | undefined> {
    const story = this.story(storyId);
    if (!story || this.progress.seenStories.includes(story.story_id)) return undefined;
    await this.saveProgress(markStorySeen(this.progress, story.story_id));
    return story;
  }

  startBattle(stepIndex: number, kind: BattleKind): Battle {
    const view = this.steps()[stepIndex];
    if (!view) throw new Error(`no step ${stepIndex}`);
    if (view.status === "locked") throw new Error(`step ${stepIndex} is locked`);
    if (kind === "boss" && view.status === "open") throw new Error(`the boss of ${view.module.module_id} is not unlocked yet`);
    if (kind !== "encounter" && kind !== "boss") throw new Error(`use startPatrol or startRepair for a ${kind}`);
    const random = this.d.random ?? Math.random;
    const enemy =
      kind === "boss" ? view.boss : view.encounterEnemies[Math.floor(random() * view.encounterEnemies.length)] ?? { ...view.boss, role: "minion" as const };
    return this.begin(new Battle({ kind, enemy, module: view.module, tasks: this.tasks, lastSeen: this.lastSeen, now: this.now().getTime(), random, ...this.knight() }));
  }

  // ── The knight and the city ──────────────────────────────────────────────

  hud(): Hud {
    const bonuses = this.bonuses();
    return { ...levelOf(this.progress.xp, this.rules), xp: this.progress.xp, kp: this.progress.kp, maxHp: this.maxHp(bonuses), bonuses };
  }

  city(): BuildingView[] {
    return cityView(this.bundle, this.track, this.progress, this.scheduler, this.rules, this.now(), this.lastCorrect);
  }

  /** Builds a building whose site is open, for its KP cost. */
  async build(buildingId: string): Promise<void> {
    const view = this.city().find((v) => v.building.building_id === buildingId);
    if (!view) throw new Error(`building ${buildingId} is not in this track`);
    if (view.state !== "site") throw new Error(`building ${buildingId} cannot be built now (${view.state})`);
    if (!view.affordable) throw new Error(`building ${buildingId} costs ${view.building.cost_kp} KP`);
    const p = addCurrency(this.progress, { xp: 0, kp: -view.building.cost_kp });
    await this.saveProgress({ ...p, buildings: { ...p.buildings, [buildingId]: { builtAt: this.now().toISOString(), damaged: false, repairs: 0 } } });
    await this.outbox.enqueue([this.builder.built({ ...this.common(), buildingId, moduleId: view.module.module_id, contentVersion: `${view.module.module_id}@${view.module.version}` })]);
  }

  /**
   * Compares the live state of the buildings with the last known one. A building
   * that was damaged and now stands whole has been repaired: xAPI "repaired" and a
   * reward. Called when the city opens and after every battle.
   */
  async checkRepairs(o: { damageOnly?: boolean } = {}): Promise<{ repaired: Building[]; earned: { xp: number; kp: number } }> {
    const repaired: Building[] = [];
    let earned = { xp: 0, kp: 0 };
    let p = this.progress;
    const statements = [];
    for (const v of this.city()) {
      const stored = p.buildings[v.building.building_id];
      if (!stored) continue;
      const damaged = v.state === "damaged";
      if (damaged === stored.damaged || (o.damageOnly && !damaged)) continue;
      p = { ...p, buildings: { ...p.buildings, [v.building.building_id]: { ...stored, damaged, repairs: stored.repairs + (damaged ? 0 : 1) } } };
      if (damaged) continue;
      repaired.push(v.building);
      const r = scaleReward(this.rules.rewards.building_repaired, this.bonuses());
      earned = { xp: earned.xp + r.xp, kp: earned.kp + r.kp };
      statements.push(this.builder.repaired({ ...this.common(), buildingId: v.building.building_id, moduleId: v.module.module_id }));
    }
    if (p !== this.progress) await this.saveProgress(addCurrency(p, earned));
    if (statements.length) await this.outbox.enqueue(statements);
    return { repaired, earned };
  }

  // ── Daily patrol and repair ──────────────────────────────────────────────

  patrolStatus(): PatrolStatus {
    const now = this.now();
    const today = localDay(now);
    const studied = this.patrolModules()
      .flatMap((m) => m.concepts.map((c) => c.concept_id))
      .filter((id) => this.scheduler.has(id));
    const days = new Set(this.progress.patrolDays);
    const week = new Set(Array.from({ length: 7 }, (_, i) => localDay(new Date(now.getTime() - i * DAY_MS))));
    let streak = 0;
    for (let i = days.has(today) ? 0 : 1; days.has(localDay(new Date(now.getTime() - i * DAY_MS))); i++) streak++;
    return {
      doneToday: days.has(today),
      dueConcepts: this.scheduler.due(now, studied).length,
      studiedConcepts: studied.length,
      daysThisWeek: [...days].filter((d) => week.has(d)).length,
      streak,
    };
  }

  /** Today's patrol: tasks for due concepts of every module the knight has reached, weakest first. */
  startPatrol(): Battle {
    const script = buildPatrol(this.bundle, this.scheduler, {
      moduleIds: this.patrolModules().map((m) => m.module_id),
      lastSeen: this.lastSeen,
      now: this.now(),
      size: this.rules.patrol.size,
      cooldownDays: this.rules.patrol.task_cooldown_days,
      ...(this.d.random ? { random: this.d.random } : {}),
    });
    if (!script.length) throw new Error("nothing to patrol yet: no concept has been practised");
    return this.begin(new Battle({ kind: "patrol", enemy: this.patrolEnemy(), script, random: this.d.random ?? Math.random, ...this.knight() }));
  }

  /** A repair: a short review of the fading concepts of one damaged building's module. */
  async startRepair(buildingId: string): Promise<Battle> {
    await this.checkRepairs();
    const view = this.city().find((v) => v.building.building_id === buildingId);
    if (view?.state !== "damaged") throw new Error(`building ${buildingId} does not need repair`);
    const script = buildPatrol(this.bundle, this.scheduler, {
      moduleIds: [view.module.module_id],
      lastSeen: this.lastSeen,
      now: this.now(),
      size: this.rules.repair.task_count,
      cooldownDays: this.rules.patrol.task_cooldown_days,
      ...(this.d.random ? { random: this.d.random } : {}),
    });
    const battle = new Battle({ kind: "repair", enemy: this.patrolEnemy(), script, random: this.d.random ?? Math.random, ...this.knight() });
    this.repairing.set(battle, view.building);
    return this.begin(battle);
  }

  /** The building a repair battle is for. */
  repairTarget(battle: Battle): Building | undefined {
    return this.repairing.get(battle);
  }

  // ── Statistics ───────────────────────────────────────────────────────────

  async errorReport(days?: number): Promise<ErrorReport> {
    return errorReport(this.bundle, await this.d.journal.all(), this.scheduler, { now: this.now(), ...(days !== undefined ? { days } : {}) });
  }

  // ── Battles ──────────────────────────────────────────────────────────────

  async answer(battle: Battle, task: Task, input: AnswerInput): Promise<AnswerResult> {
    const attemptNo = (this.attemptNo.get(task.task_id) ?? 0) + 1;
    this.attemptNo.set(task.task_id, attemptNo);
    if (input.hintUsed) battle.spendHint();
    const building = this.repairing.get(battle);
    // Note cracks before the answer changes FSRS, so that a review that fixes them counts as a repair.
    await this.checkRepairs({ damageOnly: true });
    const { outcome } = await this.engine.submit({
      taskId: task.task_id,
      response: input.response,
      hintUsed: input.hintUsed,
      durationMs: input.durationMs,
      attemptNo,
      gameContext: {
        scene: "battle",
        mode: MODE[battle.kind],
        enemy: battle.enemy.enemy_id,
        encounter_id: battle.id,
        track: this.track.track_id,
        ...(building ? { building: building.building_id } : {}),
      },
    });
    this.lastSeen.set(task.task_id, this.now().getTime());
    this.lastCorrect.set(task.concept_id, outcome.correct);
    await this.d.kv.set(KEYS.cards, this.scheduler.toJSON());
    const reward = outcome.correct
      ? scaleReward(this.rules.rewards.answer_correct, this.bonuses(), task.difficulty)
      : outcome.match === "typo"
        ? scaleReward(this.rules.rewards.answer_typo ?? {}, this.bonuses())
        : { xp: 0, kp: 0 };
    if (reward.xp || reward.kp) await this.saveProgress(addCurrency(this.progress, reward));
    this.battleXp += reward.xp;
    return { outcome, strike: battle.resolve(task, outcome), xp: reward.xp };
  }

  async finishBattle(battle: Battle): Promise<BattleEnd> {
    const state = battle.state;
    if (state === "ongoing") throw new Error("the battle is not over");
    let earned = { xp: this.battleXp, kp: 0 };
    const grant = async (r: Reward) => {
      const scaled = scaleReward(r, this.bonuses());
      earned = { xp: earned.xp + scaled.xp, kp: earned.kp + scaled.kp };
      await this.saveProgress(addCurrency(this.progress, scaled));
    };
    const end = async (e: Omit<BattleEnd, "earned" | "repaired">): Promise<BattleEnd> => {
      const r = await this.checkRepairs();
      earned = { xp: earned.xp + r.earned.xp, kp: earned.kp + r.earned.kp };
      const level = levelOf(this.progress.xp, this.rules).level;
      return { ...e, earned, repaired: r.repaired, ...(level > this.battleLevel ? { levelUp: level } : {}) };
    };

    if (battle.kind === "patrol" || battle.kind === "repair") {
      if (battle.kind === "repair") return end({ state });
      const today = localDay(this.now());
      const rewarded = !this.progress.patrolDays.includes(today);
      if (rewarded) {
        await this.saveProgress({ ...this.progress, patrolDays: [...this.progress.patrolDays, today] });
        await grant(this.rules.rewards.patrol_completed);
      }
      return end({ state, patrolRewarded: rewarded });
    }

    const module = battle.module!;
    const moduleId = module.module_id;
    if (battle.kind === "encounter") {
      if (state === "won") {
        await this.outbox.enqueue([this.builder.defeated({ ...this.common(), enemyId: battle.enemy.enemy_id, moduleId, gameContext: { encounter_id: battle.id } })]);
        await this.saveProgress(recordEncounterWin(this.progress, moduleId));
        await grant(this.rules.rewards.encounter_won);
      }
      return end({ state });
    }

    const wasCleared = this.progress.modules[moduleId]?.bossPassed ?? false;
    const r = await this.engine.moduleResult({
      moduleId,
      correct: battle.correct,
      total: battle.answered,
      trackId: this.track.track_id,
      durationMs: this.now().getTime() - this.battleStartedAt,
    });
    if (state === "won") {
      await this.outbox.enqueue([this.builder.defeated({ ...this.common(), enemyId: battle.enemy.enemy_id, moduleId, gameContext: { encounter_id: battle.id } })]);
    }
    await this.saveProgress(recordBossResult(this.progress, moduleId, r));
    await this.queueResult({ module_id: moduleId, correct: battle.correct, total: battle.answered });
    const step = this.steps().find((s) => s.module.module_id === moduleId);
    const firstWin = r.passed && !wasCleared;
    if (firstWin) await grant(this.rules.rewards.boss_passed);
    const outro = firstWin ? await this.storyOnce(step?.step.outro) : undefined;
    const unlocked = firstWin ? this.bundle.buildings.find((b) => b.building_id === step?.step.unlocks_building) : undefined;
    return end({
      state,
      moduleResult: { passed: r.passed, scaled: r.scaled, correct: battle.correct, total: battle.answered },
      ...(outro ? { outro } : {}),
      ...(unlocked ? { unlockedBuilding: unlocked } : {}),
    });
  }

  /** Delivers queued statements and module results. The scenes call it after each battle and on a timer; failures stay queued. */
  async sync(): Promise<{ pendingStatements: number; pendingResults: number }> {
    await this.outbox.flush().catch(() => undefined);
    let pending = (await this.d.kv.get<PendingResult[]>(KEYS.pendingResults)) ?? [];
    if (this.d.reportModuleResult && pending.length) {
      const left: PendingResult[] = [];
      for (const r of pending) {
        try {
          await this.d.reportModuleResult(r);
        } catch {
          left.push(r);
        }
      }
      // Results queued while this ran are kept too.
      const now = (await this.d.kv.get<PendingResult[]>(KEYS.pendingResults)) ?? [];
      pending = [...left, ...now.slice(pending.length)];
      await this.d.kv.set(KEYS.pendingResults, pending);
    }
    return { pendingStatements: await this.d.outboxStore.pendingCount(), pendingResults: pending.length };
  }

  private async queueResult(r: PendingResult): Promise<void> {
    const pending = (await this.d.kv.get<PendingResult[]>(KEYS.pendingResults)) ?? [];
    await this.d.kv.set(KEYS.pendingResults, [...pending, r]);
  }

  private async saveProgress(p: PlayerProgress): Promise<void> {
    this.progress = p;
    await this.d.kv.set(KEYS.progress, p);
  }

  private begin(battle: Battle): Battle {
    this.attemptNo = new Map();
    this.battleStartedAt = this.now().getTime();
    this.battleXp = 0;
    this.battleLevel = levelOf(this.progress.xp, this.rules).level;
    return battle;
  }

  private bonuses(): CityBonuses {
    return cityBonuses(this.city());
  }

  private maxHp(b: CityBonuses): number {
    return this.rules.knight.base_hp + (levelOf(this.progress.xp, this.rules).level - 1) * this.rules.levels.hp_per_level + b.maxHp;
  }

  /** The knight's HP and hints for a new battle: level and whole buildings count. */
  private knight(): { knightMaxHp: number; hints: number } {
    const b = this.bonuses();
    return { knightMaxHp: this.maxHp(b), hints: this.rules.knight.hints_per_battle + b.hintCharges };
  }

  /** Modules the knight has reached on the map: their practised concepts may come up on patrol. */
  private patrolModules(): Module[] {
    return this.steps()
      .filter((s) => s.status !== "locked")
      .map((s) => s.module);
  }

  private patrolEnemy(): Enemy {
    const ids = this.rules.patrol.enemies;
    const id = ids[Math.floor((this.d.random ?? Math.random)() * ids.length)];
    return (
      this.bundle.enemies.find((e) => e.enemy_id === id) ??
      this.bundle.enemies.find((e) => e.role !== "boss") ?? { enemy_id: "shadow", name: { en: "Shadow", ru: "Тень" }, sprite: "", role: "minion", hp: 30, damage: 0 }
    );
  }

  private common() {
    return { playerId: this.d.playerId, registration: this.d.registration, timestamp: this.now() };
  }
}
