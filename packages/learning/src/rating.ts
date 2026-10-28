import { Rating, type Grade } from "ts-fsrs";
import type { CheckOutcome } from "./check.js";

export interface RatingInput {
  outcome: Pick<CheckOutcome, "correct" | "match">;
  hintUsed: boolean;
  durationMs: number;
  /** The player's median answer time for this concept, if known. */
  medianDurationMs?: number;
  /** The task's time limit; an answer in the last quarter of it counts as slow. */
  timeLimitMs?: number;
}

/**
 * Derives the FSRS grade from an attempt, so the player never rates themselves:
 * wrong → Again; typo, hint or slow → Hard; faster than the player's median → Easy;
 * otherwise Good. A typo counts as recalled with effort, whether or not the task type accepts it:
 * the grammar or the hearing was right.
 */
export function deriveRating(i: RatingInput): Grade {
  if (i.outcome.match === "typo") return Rating.Hard;
  if (!i.outcome.correct) return Rating.Again;
  if (i.hintUsed) return Rating.Hard;
  if (i.timeLimitMs !== undefined && i.durationMs > i.timeLimitMs * 0.75) return Rating.Hard;
  if (i.medianDurationMs !== undefined && i.durationMs > i.medianDurationMs * 1.5) return Rating.Hard;
  if (i.medianDurationMs !== undefined && i.durationMs < i.medianDurationMs) return Rating.Easy;
  return Rating.Good;
}
