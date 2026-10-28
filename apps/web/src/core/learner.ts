import type { ContentBundle, Task } from "@moonbridge/content";
import {
  ConceptScheduler,
  LearningEngine,
  RepeatSchedule,
  type AttemptJournal,
  type RepeatItem,
  type Response,
  type StoredConceptCard,
  type SubmitResult,
} from "@moonbridge/learning";
import { Outbox, StatementBuilder, XapiProfile, type OutboxStore, type StatementSink } from "@moonbridge/xapi";
import type { KeyValue } from "../storage/idb.js";

export interface LearnerDeps {
  bundle: ContentBundle;
  playerId: string;
  registration: string;
  xapiBaseIri: string;
  kv: KeyValue;
  journal: AttemptJournal;
  outboxStore: OutboxStore;
  sink: StatementSink;
  now?: () => Date;
}

const KEYS = { cards: "fsrs-cards", repeats: "repeats" } as const;

/**
 * The platform's learning core in the browser: every answer, from Moonbridge or from
 * homework, goes through here into one journal, one FSRS state, one 1/3/7 schedule and
 * one xAPI outbox. Sections only show tasks and react to the outcome.
 */
export class Learner {
  readonly outbox: Outbox;
  readonly scheduler: ConceptScheduler;
  readonly repeats: RepeatSchedule;
  private readonly engine: LearningEngine;
  private readonly attemptNo = new Map<string, number>();

  private constructor(private readonly d: LearnerDeps, cards: StoredConceptCard[], repeats: RepeatItem[]) {
    this.scheduler = new ConceptScheduler({}, cards);
    this.repeats = new RepeatSchedule({}, repeats);
    this.outbox = new Outbox(d.outboxStore, d.sink);
    this.engine = new LearningEngine({
      bundle: d.bundle,
      playerId: d.playerId,
      registration: d.registration,
      scheduler: this.scheduler,
      repeats: this.repeats,
      journal: d.journal,
      queue: this.outbox,
      builder: new StatementBuilder(new XapiProfile(d.xapiBaseIri)),
      ...(d.now ? { now: d.now } : {}),
    });
  }

  static async load(d: LearnerDeps): Promise<Learner> {
    const cards = (await d.kv.get<StoredConceptCard[]>(KEYS.cards)) ?? [];
    const repeats = (await d.kv.get<RepeatItem[]>(KEYS.repeats)) ?? [];
    return new Learner(d, cards, repeats);
  }

  get bundle(): ContentBundle {
    return this.d.bundle;
  }

  task(taskId: string): Task {
    return this.engine.task(taskId);
  }

  /** Checks an answer, records it everywhere and saves the schedules. `context` lands in xAPI game-context. */
  async answer(taskId: string, a: { response: Response; hintUsed: boolean; durationMs: number }, context?: Record<string, unknown>): Promise<SubmitResult> {
    const attemptNo = (this.attemptNo.get(taskId) ?? 0) + 1;
    this.attemptNo.set(taskId, attemptNo);
    const result = await this.engine.submit({ taskId, ...a, attemptNo, ...(context ? { gameContext: context } : {}) });
    await this.d.kv.set(KEYS.cards, this.scheduler.toJSON());
    await this.d.kv.set(KEYS.repeats, this.repeats.toJSON());
    return result;
  }

  /** A new scene or session: attempt numbers start again from 1. */
  resetAttempts(): void {
    this.attemptNo.clear();
  }

  /** Sends what the outbox holds; never throws, the outbox retries on its own schedule. */
  async sync(): Promise<void> {
    await this.outbox.flush().catch((e) => console.warn("xAPI sync: will retry", e));
  }
}
