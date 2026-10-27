import { normalizeAnswer, type Task } from "@moonbridge/content";
import { editDistance } from "./levenshtein.js";

export type MatchKind = "accepted" | "known_error" | "typo" | "unclassified";

export interface CheckOutcome {
  correct: boolean;
  match: MatchKind;
  /** Taxonomy id; absent when correct. */
  errorType?: string;
  /** Author feedback from known_errors, when there is one. */
  feedback?: string;
  /** The response as the player gave it, flattened to a string (order_words tokens joined by spaces). */
  response: string;
  /** First accepted answer, shown to the player and sent to xAPI as correct-form. */
  correctForm: string;
}

/** Response shape per task type: option id for choice, token list for order_words, text otherwise. */
export type Response = string | string[];

/**
 * Typo tolerance by answer length. Short answers get none: "a"/"an" or "is"/"as"
 * differ by one letter and that difference is the grammar being tested.
 */
export function typoBudget(answerLength: number): number {
  if (answerLength <= 3) return 0;
  if (answerLength <= 6) return 1;
  return 2;
}

/**
 * Classifies a response. The chain stops at the first hit:
 * 1. normalized match with `accepted` → correct
 * 2. match with author-tagged `known_errors` → that error type and feedback
 * 3. within the typo budget of an accepted answer → spelling.typo (free-text types only)
 * 4. otherwise → unclassified (surfaced in the review screen so the author can tag it)
 */
export function checkAnswer(task: Task, raw: Response): CheckOutcome {
  const cs = task.answer.case_sensitive ?? false;
  const response = Array.isArray(raw) ? raw.join(" ") : raw;
  const norm = normalizeAnswer(response, cs);
  const correctForm = displayAnswer(task);

  const accepted = task.answer.accepted.map((a) => normalizeAnswer(a, cs));
  if (accepted.includes(norm)) return { correct: true, match: "accepted", response, correctForm };

  for (const ke of task.answer.known_errors ?? []) {
    if (ke.match.some((m) => normalizeAnswer(m, cs) === norm)) {
      return {
        correct: false,
        match: "known_error",
        errorType: ke.error_type,
        ...(ke.feedback ? { feedback: ke.feedback } : {}),
        response,
        correctForm,
      };
    }
  }

  if (task.type !== "choice" && task.type !== "order_words" && norm.length > 0) {
    const closest = Math.min(...accepted.map((a) => (editDistance(norm, a) <= typoBudget(a.length) ? editDistance(norm, a) : Infinity)));
    if (Number.isFinite(closest) && closest > 0) {
      return { correct: false, match: "typo", errorType: "spelling.typo", response, correctForm };
    }
  }

  return { correct: false, match: "unclassified", errorType: "unclassified", response, correctForm };
}

function displayAnswer(task: Task): string {
  const first = task.answer.accepted[0]!;
  if (task.type === "choice") return task.presentation.options?.find((o) => o.id === first)?.text ?? first;
  return first;
}
