import type { ContentBundle, Story, Task, Track } from "@knight/content";
import { ConceptScheduler, LearningEngine, type AttemptJournal, type CheckOutcome, type Response, type StoredConceptCard } from "@knight/learning";
import { KnightProfile, Outbox, StatementBuilder, type OutboxStore, type StatementSink } from "@knight/xapi";
import type { KeyValue } from "../storage/idb.js";
import { Battle, type BattleKind, type Strike } from "./battle.js";
import { emptyProgress, markStorySeen, recordBossResult, recordEncounterWin, trackView, type PlayerProgress, type StepView } from "./progress.js";

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
}

export interface BattleEnd {
  state: "won" | "lost";
  /** Set for boss fights: the module result as recorded in xAPI and sent to the LMS. */
  moduleResult?: { passed: boolean; scaled: number; correct: number; total: number };
  /** The step's outro story, when a boss was defeated for the first time. */
  outro?: Story;
}

const KEYS = { progress: "progress", cards: "fsrs-cards", pendingResults: "pending-module-results" } as const;

/**
 * Everything the scenes need, without Phaser: progress, battles, answers through
 * the learning engine, statements into the outbox. Scenes only draw and ask.
 */
export class Game {
  readonly bundle: ContentBundle;
  readonly track: Track;
  readonly outbox: Outbox;
  readonly scheduler: ConceptScheduler;
  progress: PlayerProgress;
  private readonly engine: LearningEngine;
  private readonly builder: StatementBuilder;
  private readonly tasks: Map<string, Task>;
  private readonly lastSeen = new Map<string, number>();
  private readonly now: () => Date;
  private attemptNo = new Map<string, number>();
  private battleStartedAt = 0;

  private constructor(private readonly d: GameDeps, progress: PlayerProgress, cards: StoredConceptCard[]) {
    this.bundle = d.bundle;
    const track = d.trackId ? d.bundle.tracks.find((t) => t.track_id === d.trackId) : d.bundle.tracks[0];
    if (!track) throw new Error(`track ${d.trackId ?? "(first)"} is not in the content bundle`);
    this.track = track;
    this.now = d.now ?? (() => new Date());
    this.progress = progress;
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
    const progress = (await d.kv.get<PlayerProgress>(KEYS.progress)) ?? emptyProgress();
    const cards = (await d.kv.get<StoredConceptCard[]>(KEYS.cards)) ?? [];
    const game = new Game(d, progress, cards);
    for (const a of await d.journal.all()) game.lastSeen.set(a.task_id, Date.parse(a.timestamp));
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
    const random = this.d.random ?? Math.random;
    const enemy =
      kind === "boss" ? view.boss : view.encounterEnemies[Math.floor(random() * view.encounterEnemies.length)] ?? { ...view.boss, role: "minion" as const };
    this.attemptNo = new Map();
    this.battleStartedAt = this.now().getTime();
    return new Battle({ kind, enemy, module: view.module, tasks: this.tasks, lastSeen: this.lastSeen, now: this.now().getTime(), random });
  }

  async answer(battle: Battle, task: Task, input: AnswerInput): Promise<AnswerResult> {
    const attemptNo = (this.attemptNo.get(task.task_id) ?? 0) + 1;
    this.attemptNo.set(task.task_id, attemptNo);
    const { outcome } = await this.engine.submit({
      taskId: task.task_id,
      response: input.response,
      hintUsed: input.hintUsed,
      durationMs: input.durationMs,
      attemptNo,
      gameContext: {
        scene: "battle",
        mode: battle.kind === "boss" ? "boss" : "quest",
        enemy: battle.enemy.enemy_id,
        encounter_id: battle.id,
        track: this.track.track_id,
      },
    });
    this.lastSeen.set(task.task_id, this.now().getTime());
    await this.d.kv.set(KEYS.cards, this.scheduler.toJSON());
    return { outcome, strike: battle.resolve(task, outcome) };
  }

  async finishBattle(battle: Battle): Promise<BattleEnd> {
    const state = battle.state;
    if (state === "ongoing") throw new Error("the battle is not over");
    const moduleId = battle.module.module_id;

    if (battle.kind === "encounter") {
      if (state === "won") {
        await this.outbox.enqueue([this.builder.defeated({ ...this.common(), enemyId: battle.enemy.enemy_id, moduleId, gameContext: { encounter_id: battle.id } })]);
        await this.saveProgress(recordEncounterWin(this.progress, moduleId));
      }
      return { state };
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
    const outro = r.passed && !wasCleared ? await this.storyOnce(step?.step.outro) : undefined;
    return { state, moduleResult: { passed: r.passed, scaled: r.scaled, correct: battle.correct, total: battle.answered }, ...(outro ? { outro } : {}) };
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

  private common() {
    return { playerId: this.d.playerId, registration: this.d.registration, timestamp: this.now() };
  }
}
