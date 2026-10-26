import type { Task } from "@knight/content";
import { beforeAll, describe, expect, it } from "vitest";
import { checkAnswer, deriveRating, editDistance, Rating, typoBudget } from "../src/index.js";
import { loadBundle } from "./fixtures.js";

let tasks: Record<string, Task>;
beforeAll(async () => {
  tasks = (await loadBundle()).tasks;
});

describe("checkAnswer on the real Past Simple task (go → went)", () => {
  const q3 = () => tasks["A1_PastSimple_01_q3"]!;

  it("accepts the answer regardless of case and spaces", () => {
    expect(checkAnswer(q3(), "  Went ")).toMatchObject({ correct: true, match: "accepted" });
  });

  it("goed → grammar.overgeneralization with the author's feedback", () => {
    const r = checkAnswer(q3(), "goed");
    expect(r).toMatchObject({ correct: false, match: "known_error", errorType: "grammar.overgeneralization", correctForm: "went" });
    expect(r.feedback).toContain("went");
  });

  it("wnet → spelling.typo", () => {
    expect(checkAnswer(q3(), "wnet")).toMatchObject({ correct: false, match: "typo", errorType: "spelling.typo" });
  });

  it("an unknown answer → unclassified", () => {
    expect(checkAnswer(q3(), "flew")).toMatchObject({ correct: false, match: "unclassified", errorType: "unclassified" });
  });
});

describe("checkAnswer by task type", () => {
  it("choice compares option ids and never guesses typos", () => {
    const t = tasks["A1_PastSimple_01_q5"]!;
    expect(checkAnswer(t, "b").correct).toBe(true);
    expect(checkAnswer(t, "a").errorType).toBe("grammar.overgeneralization");
    expect(checkAnswer(t, "c").errorType).toBe("grammar.wrong_form_v3");
    expect(checkAnswer(t, "b").correctForm).toBe("ate");
  });

  it("order_words joins the tokens and ignores spacing before ?", () => {
    const t = tasks["A1_VerbToBe_01_q8"]!;
    expect(checkAnswer(t, ["Are", "you", "a", "friend", "?"]).correct).toBe(true);
    expect(checkAnswer(t, ["You", "are", "a", "friend", "?"]).errorType).toBe("grammar.word_order");
  });

  it("transform accepts any listed variant, including contractions with a curly apostrophe", () => {
    const t = tasks["A1_VerbToBe_01_q6"]!;
    expect(checkAnswer(t, "We aren’t afraid of the dark").correct).toBe(true);
    expect(checkAnswer(t, "We don't are afraid of the dark.").errorType).toBe("grammar.auxiliary");
  });

  it("does not call a wrong article a typo", () => {
    const t = tasks["A1_Articles_01_q2"]!; // There is ___ map → a
    expect(typoBudget(1)).toBe(0);
    expect(checkAnswer(t, "an").errorType).toBe("grammar.article");
    expect(checkAnswer(t, "o").match).toBe("unclassified");
  });
});

describe("editDistance", () => {
  it("counts a transposition as one edit", () => {
    expect(editDistance("went", "wnet")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
  });
});

describe("deriveRating", () => {
  const ok = { correct: true, match: "accepted" as const };
  it("maps attempts to FSRS grades", () => {
    expect(deriveRating({ outcome: { correct: false, match: "known_error" }, hintUsed: false, durationMs: 3000 })).toBe(Rating.Again);
    expect(deriveRating({ outcome: { correct: false, match: "typo" }, hintUsed: false, durationMs: 3000 })).toBe(Rating.Hard);
    expect(deriveRating({ outcome: ok, hintUsed: true, durationMs: 3000 })).toBe(Rating.Hard);
    expect(deriveRating({ outcome: ok, hintUsed: false, durationMs: 22000, timeLimitMs: 25000 })).toBe(Rating.Hard);
    expect(deriveRating({ outcome: ok, hintUsed: false, durationMs: 3000, medianDurationMs: 5000 })).toBe(Rating.Easy);
    expect(deriveRating({ outcome: ok, hintUsed: false, durationMs: 5000, medianDurationMs: 5000 })).toBe(Rating.Good);
    expect(deriveRating({ outcome: ok, hintUsed: false, durationMs: 5000 })).toBe(Rating.Good);
  });
});
