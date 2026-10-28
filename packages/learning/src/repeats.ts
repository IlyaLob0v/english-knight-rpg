const DAY_MS = 24 * 60 * 60 * 1000;

/** One concept the player got wrong, waiting to come back. Stored as JSON with the player's progress. */
export interface RepeatItem {
  concept_id: string;
  /** School day of the error that started (or restarted) the cycle, as days since 1970-01-01. */
  origin_day: number;
  /** How many reviews of this cycle were passed: 0 before the first one. */
  step: number;
  /** The task and error type of the latest error: what the lost-and-found item is made of. */
  task_id: string;
  error_type: string;
}

export interface RepeatOptions {
  /** Days after the error on which the concept comes back. Ksenia's rule: 1, 3 and 7. */
  intervals?: number[];
  /** Where the school day starts, as an offset from UTC. Default: Moscow (UTC+3). */
  utcOffsetMinutes?: number;
}

export type RepeatEvent = "started" | "restarted" | "advanced" | "retired" | "none";

/**
 * The fixed "1/3/7 days" repetition mode. An error on day 0 brings its concept back on
 * days 1, 3 and 7 after it. A correct answer on or after a due day passes that review;
 * a wrong answer at any time restarts the cycle from that day. After the last review the
 * concept is retired. Days are calendar days in the school's time zone, so an error at
 * 23:50 comes back the next morning, not 24 hours later.
 *
 * This runs alongside FSRS (ConceptScheduler): FSRS keeps scheduling vocabulary cards,
 * this one decides what the lost-and-found brings back.
 */
export class RepeatSchedule {
  readonly intervals: number[];
  private readonly offsetMs: number;
  private readonly items = new Map<string, RepeatItem>();

  constructor(options: RepeatOptions = {}, stored: RepeatItem[] = []) {
    this.intervals = options.intervals ?? [1, 3, 7];
    if (!this.intervals.length || this.intervals.some((d, i) => !Number.isInteger(d) || d < 1 || d <= (this.intervals[i - 1] ?? 0))) {
      throw new Error(`intervals must be increasing whole days, got ${JSON.stringify(this.intervals)}`);
    }
    this.offsetMs = (options.utcOffsetMinutes ?? 180) * 60_000;
    for (const item of stored) this.items.set(item.concept_id, { ...item });
  }

  /** The school day of a moment, as days since 1970-01-01. */
  day(at: Date): number {
    return Math.floor((at.getTime() + this.offsetMs) / DAY_MS);
  }

  /** Feeds one answer in. Call it for every attempt; answers to concepts that are not due change nothing. */
  record(a: { conceptId: string; correct: boolean; taskId: string; errorType?: string }, at: Date): RepeatEvent {
    const today = this.day(at);
    const item = this.items.get(a.conceptId);
    if (!a.correct) {
      this.items.set(a.conceptId, {
        concept_id: a.conceptId,
        origin_day: today,
        step: 0,
        task_id: a.taskId,
        error_type: a.errorType ?? "unclassified",
      });
      return item ? "restarted" : "started";
    }
    if (!item || today < this.dueDay(item)) return "none";
    item.step++;
    if (item.step >= this.intervals.length) {
      this.items.delete(a.conceptId);
      return "retired";
    }
    return "advanced";
  }

  /** The day the item's next review is due. */
  dueDay(item: RepeatItem): number {
    return item.origin_day + this.intervals[item.step]!;
  }

  /** Items due on the day of `at` or earlier, the longest overdue first. */
  due(at: Date = new Date()): RepeatItem[] {
    const today = this.day(at);
    return [...this.items.values()]
      .filter((item) => this.dueDay(item) <= today)
      .sort((a, b) => this.dueDay(a) - this.dueDay(b) || a.concept_id.localeCompare(b.concept_id))
      .map((item) => ({ ...item }));
  }

  get(conceptId: string): RepeatItem | undefined {
    const item = this.items.get(conceptId);
    return item ? { ...item } : undefined;
  }

  toJSON(): RepeatItem[] {
    return [...this.items.values()].map((item) => ({ ...item }));
  }
}
