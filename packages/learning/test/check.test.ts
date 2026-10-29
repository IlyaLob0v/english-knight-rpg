import type { Task } from "@moonbridge/content";
import { beforeAll, describe, expect, it } from "vitest";
import { checkAnswer, deriveRating, displayResponse, editDistance, isTypoOf, Rating, typoBudget } from "../src/index.js";
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

describe("checkAnswer on the four Moonbridge types", () => {
  it("listen_type accepts a typo as correct, but still logs it", () => {
    const t = tasks["A1_VerbToBe_01_q13"]!; // We are tired travellers
    expect(checkAnswer(t, "we are tired travellers")).toMatchObject({ correct: true, match: "accepted" });
    expect(checkAnswer(t, "We're tired travelers")).toMatchObject({ correct: true, match: "typo", errorType: "spelling.typo" });
    expect(checkAnswer(t, "We are tierd travellers")).toMatchObject({ correct: true, match: "typo" });
    expect(deriveRating({ outcome: checkAnswer(t, "We are tierd travellers"), hintUsed: false, durationMs: 1000 })).toBe(Rating.Hard);
  });

  it("listen_type does not take a wrong short word or a missing word for a typo", () => {
    const t = tasks["A1_VerbToBe_01_q13"]!;
    expect(checkAnswer(t, "We is tired travellers")).toMatchObject({ correct: false, errorType: "grammar.agreement" });
    expect(checkAnswer(t, "We our tired travellers")).toMatchObject({ correct: false, match: "unclassified" });
    expect(checkAnswer(t, "We tired travellers")).toMatchObject({ correct: false, match: "unclassified" });
  });

  it("translate_ru_en accepts any listed variant, ignoring case and articles", () => {
    const t = tasks["A1_VerbToBe_01_q14"]!; // Я не волшебник, я рыцарь.
    expect(checkAnswer(t, "I am not a wizard, I am a knight.").correct).toBe(true);
    expect(checkAnswer(t, "i'M NOT A WIZARD, I'M A KNIGHT").correct).toBe(true);
    expect(checkAnswer(t, "I'm not wizard, I'm the knight")).toMatchObject({ correct: true, match: "accepted" });
    expect(checkAnswer(t, "I not a wizard, I a knight")).toMatchObject({ correct: false, errorType: "grammar.auxiliary" });
    expect(checkAnswer(t, "I'm not a wizzard, I'm a knight")).toMatchObject({ correct: false, match: "typo" });
  });

  it("ignore_articles can be switched off for a translation, and on for another type", () => {
    const t = tasks["A1_VerbToBe_01_q14"]!;
    const strict = { ...t, answer: { ...t.answer, ignore_articles: false } };
    expect(checkAnswer(strict, "I'm not wizard, I'm knight").correct).toBe(false);
    const listen = tasks["A1_VerbToBe_01_q13"]!;
    expect(checkAnswer({ ...listen, answer: { ...listen.answer, ignore_articles: true } }, "We are the tired travellers").correct).toBe(true);
  });

  it("translate_en_ru compares option ids and shows the option text", () => {
    const t = tasks["A1_VerbToBe_01_q15"]!;
    expect(checkAnswer(t, "a")).toMatchObject({ correct: true, correctForm: "Ты из замка?" });
    expect(checkAnswer(t, "b").errorType).toBe("grammar.tense_not_changed");
    expect(checkAnswer(t, "A").correct).toBe(true);
  });

  it("find_error takes the token index and shows the correction", () => {
    const t = tasks["A1_VerbToBe_01_q16"]!; // My friends is brave .
    expect(checkAnswer(t, "2")).toMatchObject({ correct: true, correctForm: "are" });
    expect(checkAnswer(t, "0")).toMatchObject({ correct: false, errorType: "comprehension.misread_prompt" });
    expect(checkAnswer(t, "1")).toMatchObject({ correct: false, match: "unclassified" });
    expect(checkAnswer(t, "12")).toMatchObject({ correct: false, match: "unclassified" });
  });

  it("shows the student's answer as they saw it: the option's text, the word they tapped", () => {
    expect(displayResponse(tasks["A1_PastSimple_01_q5"]!, "a")).toBe("eated");
    expect(displayResponse(tasks["A1_VerbToBe_01_q16"]!, "0")).toBe("My");
    expect(displayResponse(tasks["A1_VerbToBe_01_q16"]!, "12")).toBe("12");
    expect(displayResponse(tasks["A1_PastSimple_01_q3"]!, "goed")).toBe("goed");
  });
});

describe("isTypoOf", () => {
  it("compares word by word with the budget of each word", () => {
    expect(isTypoOf("i'm here", "i'm here")).toBe(false);
    expect(isTypoOf("travelers", "travellers")).toBe(true);
    expect(isTypoOf("an apple", "a apple")).toBe(false);
    expect(isTypoOf("hello wrold", "hello world")).toBe(true);
    expect(isTypoOf("helo wrold", "hello world")).toBe(true);
    expect(isTypoOf("hello", "hello world")).toBe(false);
  });
});
