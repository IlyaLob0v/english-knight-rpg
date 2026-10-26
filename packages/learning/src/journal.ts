import type { Grade } from "ts-fsrs";
import type { MatchKind } from "./check.js";

/**
 * One answer to one task. This record is the single source for the player's error
 * statistics and for the xAPI "answered" statement, so the two never disagree.
 */
export interface Attempt {
  /** UUID; reused as the xAPI statement id. */
  attempt_id: string;
  task_id: string;
  module_id: string;
  concept_id: string;
  response: string;
  correct: boolean;
  match: MatchKind;
  error_type?: string;
  hint_used: boolean;
  duration_ms: number;
  /** 1 for the first try at this task in this encounter. */
  attempt_no: number;
  rating: Grade;
  content_version: string;
  game_context?: Record<string, unknown>;
  timestamp: string;
}

export interface AttemptJournal {
  append(attempt: Attempt): Promise<void>;
  all(): Promise<Attempt[]>;
}

export class MemoryJournal implements AttemptJournal {
  private readonly attempts: Attempt[] = [];
  async append(attempt: Attempt): Promise<void> {
    this.attempts.push(attempt);
  }
  async all(): Promise<Attempt[]> {
    return [...this.attempts];
  }
}

export interface ErrorStats {
  total: number;
  correct: number;
  /** Error types by frequency, most frequent first. */
  topErrorTypes: { error_type: string; count: number }[];
  byConcept: Record<string, { attempts: number; errors: number }>;
  /** Unclassified wrong answers, grouped: the author's to-do list for known_errors. */
  unclassified: { task_id: string; response: string; count: number }[];
}

export function errorStats(attempts: Attempt[], top = 5): ErrorStats {
  const byType = new Map<string, number>();
  const byConcept: ErrorStats["byConcept"] = {};
  const unclassified = new Map<string, { task_id: string; response: string; count: number }>();
  let correct = 0;
  for (const a of attempts) {
    const c = (byConcept[a.concept_id] ??= { attempts: 0, errors: 0 });
    c.attempts++;
    if (a.correct) {
      correct++;
      continue;
    }
    c.errors++;
    const type = a.error_type ?? "unclassified";
    byType.set(type, (byType.get(type) ?? 0) + 1);
    if (a.match === "unclassified") {
      const key = `${a.task_id}\u0000${a.response.trim().toLowerCase()}`;
      const u = unclassified.get(key) ?? { task_id: a.task_id, response: a.response.trim(), count: 0 };
      u.count++;
      unclassified.set(key, u);
    }
  }
  return {
    total: attempts.length,
    correct,
    topErrorTypes: [...byType]
      .map(([error_type, count]) => ({ error_type, count }))
      .sort((a, b) => b.count - a.count || a.error_type.localeCompare(b.error_type))
      .slice(0, top),
    byConcept,
    unclassified: [...unclassified.values()].sort((a, b) => b.count - a.count),
  };
}

/** Median answer time per concept, from correct answers only. */
export function medianDurations(attempts: Attempt[]): Map<string, number> {
  const times = new Map<string, number[]>();
  for (const a of attempts) if (a.correct) (times.get(a.concept_id) ?? times.set(a.concept_id, []).get(a.concept_id)!).push(a.duration_ms);
  const out = new Map<string, number>();
  for (const [id, list] of times) {
    list.sort((x, y) => x - y);
    const mid = Math.floor(list.length / 2);
    out.set(id, list.length % 2 ? list[mid]! : (list[mid - 1]! + list[mid]!) / 2);
  }
  return out;
}
