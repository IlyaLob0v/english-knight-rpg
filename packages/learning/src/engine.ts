import type { ContentBundle, Module, Task } from "@moonbridge/content";
import { StatementBuilder, type ActivityDefinition, type Statement } from "@moonbridge/xapi";
import type { Grade } from "ts-fsrs";
import { checkAnswer, type CheckOutcome, type Response } from "./check.js";
import { medianDurations, type Attempt, type AttemptJournal } from "./journal.js";
import { deriveRating } from "./rating.js";
import type { ConceptReview, ConceptScheduler } from "./scheduler.js";

/** Where statements go: the offline outbox in the client, the server outbox on the server. */
export interface StatementQueue {
  enqueue(statements: Statement[]): Promise<unknown>;
}

export interface EngineDeps {
  bundle: ContentBundle;
  playerId: string;
  scheduler: ConceptScheduler;
  journal: AttemptJournal;
  queue?: StatementQueue;
  builder?: StatementBuilder;
  /** Play session or LTI launch id (UUID), recorded as xAPI context.registration. */
  registration?: string;
  now?: () => Date;
}

export interface SubmitInput {
  taskId: string;
  response: Response;
  hintUsed?: boolean;
  durationMs: number;
  attemptNo?: number;
  gameContext?: Record<string, unknown>;
}

export interface SubmitResult {
  outcome: CheckOutcome;
  rating: Grade;
  review: ConceptReview;
  attempt: Attempt;
  statement: Statement;
}

const INTERACTION: Record<Task["type"], NonNullable<ActivityDefinition["interactionType"]>> = {
  choice: "choice",
  gap_fill: "fill-in",
  transform: "long-fill-in",
  order_words: "other",
};

/**
 * The learning engine facade the game calls. It knows task types, not grammar:
 * everything about a task comes from the bundle. No rendering, no game rules.
 */
export class LearningEngine {
  private readonly builder: StatementBuilder;
  private readonly now: () => Date;
  private readonly modules: Map<string, Module>;
  private medians: Map<string, number> | null = null;

  constructor(private readonly d: EngineDeps) {
    this.builder = d.builder ?? new StatementBuilder();
    this.now = d.now ?? (() => new Date());
    this.modules = new Map(d.bundle.modules.map((m) => [m.module_id, m]));
  }

  task(taskId: string): ContentBundle["tasks"][string] {
    const t = this.d.bundle.tasks[taskId];
    if (!t) throw new Error(`unknown task "${taskId}" in bundle ${this.d.bundle.content_hash}`);
    return t;
  }

  async submit(i: SubmitInput): Promise<SubmitResult> {
    const task = this.task(i.taskId);
    const module = this.modules.get(task.module_id)!;
    const now = this.now();
    const hintUsed = i.hintUsed ?? false;
    const outcome = checkAnswer(task, i.response);

    this.medians ??= medianDurations(await this.d.journal.all());
    const median = this.medians.get(task.concept_id);
    const rating = deriveRating({
      outcome,
      hintUsed,
      durationMs: i.durationMs,
      ...(median !== undefined ? { medianDurationMs: median } : {}),
      ...(task.time_limit_s ? { timeLimitMs: task.time_limit_s * 1000 } : {}),
    });
    const review = this.d.scheduler.review(task.concept_id, rating, now);

    const attempt: Attempt = {
      attempt_id: crypto.randomUUID(),
      task_id: task.task_id,
      module_id: task.module_id,
      concept_id: task.concept_id,
      response: outcome.response,
      correct: outcome.correct,
      match: outcome.match,
      ...(outcome.errorType ? { error_type: outcome.errorType } : {}),
      hint_used: hintUsed,
      duration_ms: i.durationMs,
      attempt_no: i.attemptNo ?? 1,
      rating,
      content_version: `${module.module_id}@${module.version}`,
      ...(i.gameContext ? { game_context: i.gameContext } : {}),
      timestamp: now.toISOString(),
    };
    await this.d.journal.append(attempt);
    if (outcome.correct) this.medians = null;

    const statement = this.answeredStatement(attempt, task, module);
    await this.d.queue?.enqueue([statement]);
    return { outcome, rating, review, attempt, statement };
  }

  /** The xAPI statement for an attempt. Deterministic: the same attempt always gives the same statement. */
  answeredStatement(a: Attempt, task: Task = this.task(a.task_id), module: Module = this.modules.get(a.module_id)!): Statement {
    return this.builder.answered({
      id: a.attempt_id,
      playerId: this.d.playerId,
      timestamp: new Date(a.timestamp),
      ...(this.d.registration ? { registration: this.d.registration } : {}),
      contentVersion: a.content_version,
      cefrLevel: module.cefr_level,
      ...(a.game_context ? { gameContext: a.game_context } : {}),
      taskId: a.task_id,
      moduleId: a.module_id,
      conceptId: a.concept_id,
      interactionType: INTERACTION[task.type],
      correctResponses: task.answer.accepted,
      response: a.response,
      success: a.correct,
      ...(a.error_type ? { errorType: a.error_type } : {}),
      correctForm: task.answer.accepted[0]!,
      hintUsed: a.hint_used,
      attempt: a.attempt_no,
      durationMs: a.duration_ms,
      fsrsRating: a.rating,
    });
  }

  /**
   * Records the module's boss fight: passed when the share of correct answers
   * reaches the module's pass_score. This is the score that LTI AGS later sends to the LMS.
   */
  async moduleResult(i: { moduleId: string; correct: number; total: number; trackId?: string; durationMs?: number }) {
    const module = this.modules.get(i.moduleId);
    if (!module) throw new Error(`unknown module "${i.moduleId}"`);
    const scaled = i.total > 0 ? i.correct / i.total : 0;
    const passed = scaled >= module.mastery.pass_score;
    const statement = this.builder.moduleResult({
      playerId: this.d.playerId,
      timestamp: this.now(),
      ...(this.d.registration ? { registration: this.d.registration } : {}),
      contentVersion: `${module.module_id}@${module.version}`,
      cefrLevel: module.cefr_level,
      moduleId: module.module_id,
      verb: passed ? "passed" : "failed",
      scoreRaw: i.correct,
      scoreMax: i.total,
      ...(i.trackId ? { trackId: i.trackId } : {}),
      ...(i.durationMs !== undefined ? { durationMs: i.durationMs } : {}),
    });
    await this.d.queue?.enqueue([statement]);
    return { passed, scaled, statement };
  }
}
