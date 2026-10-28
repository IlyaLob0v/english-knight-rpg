import { normalizeAnswer, type Task } from "@moonbridge/content";
import { editDistance } from "./levenshtein.js";

export type MatchKind = "accepted" | "known_error" | "typo" | "unclassified";

export interface CheckOutcome {
  correct: boolean;
  match: MatchKind;
  /** Taxonomy id. Absent when correct, except for a typo accepted in listen_type (spelling.typo). */
  errorType?: string;
  /** Author feedback from known_errors, when there is one. */
  feedback?: string;
  /** The response as the player gave it, flattened to a string (order_words tokens joined by spaces). */
  response: string;
  /** First accepted answer, shown to the player and sent to xAPI as correct-form. */
  correctForm: string;
}

/** Response shape per task type: option id for choice, token index for find_error, token list for order_words, text otherwise. */
export type Response = string | string[];

/** Types whose answer is picked, not typed: no typo or article tolerance applies. */
const PICKED = new Set<Task["type"]>(["choice", "translate_en_ru", "order_words", "find_error"]);

/**
 * Typo tolerance by word length. Short words get none: "a"/"an" or "is"/"as"
 * differ by one letter and that difference is the grammar being tested.
 */
export function typoBudget(wordLength: number): number {
  if (wordLength <= 3) return 0;
  if (wordLength <= 6) return 1;
  return 2;
}

/**
 * True when the response differs from the answer only by typos: the same number of words,
 * and each word within the typo budget of its length. A short word must match exactly,
 * so "an student" for "a student" is never a typo.
 */
export function isTypoOf(response: string, answer: string): boolean {
  if (response === answer) return false;
  const r = response.split(" ");
  const a = answer.split(" ");
  if (r.length !== a.length) return false;
  return a.every((word, i) => editDistance(r[i]!, word) <= typoBudget(word.length));
}

const ARTICLES = /(^| )(a|an|the)(?= |$)/g;

function withoutArticles(s: string): string {
  return s.replace(ARTICLES, "$1").replace(/ +/g, " ").trim();
}

/**
 * Classifies a response. The chain stops at the first hit:
 * 1. normalized match with `accepted` → correct
 * 2. match with author-tagged `known_errors` → that error type and feedback
 * 3. translate_ru_en (or ignore_articles): match once a/an/the are dropped → correct
 * 4. within the typo budget of an accepted answer → spelling.typo; counted correct in listen_type,
 *    where the skill is hearing the words, wrong elsewhere (typed types only)
 * 5. otherwise → unclassified (surfaced in the review screen so the author can tag it)
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

  if (!PICKED.has(task.type) && norm.length > 0) {
    if (task.answer.ignore_articles ?? task.type === "translate_ru_en") {
      const bare = withoutArticles(norm);
      if (accepted.some((a) => withoutArticles(a) === bare)) return { correct: true, match: "accepted", response, correctForm };
    }
    if (accepted.some((a) => isTypoOf(norm, a))) {
      return { correct: task.type === "listen_type", match: "typo", errorType: "spelling.typo", response, correctForm };
    }
  }

  return { correct: false, match: "unclassified", errorType: "unclassified", response, correctForm };
}

/** What the player is shown as the right answer: option text, the corrected word, or the first accepted string. */
export function displayAnswer(task: Task): string {
  const first = task.answer.accepted[0]!;
  if (task.type === "choice" || task.type === "translate_en_ru") return task.presentation.options?.find((o) => o.id === first)?.text ?? first;
  if (task.type === "find_error") return task.answer.correction ?? task.presentation.tokens?.[Number(first)] ?? first;
  return first;
}
