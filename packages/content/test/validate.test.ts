import { describe, expect, it } from "vitest";
import { findCycles, normalizeAnswer, validateContent, type ContentSource } from "../src/index.js";
import { buildBundle, loadContentDir } from "../src/node.js";

const CONTENT_DIR = new URL("../../../content", import.meta.url).pathname;

async function realSource(): Promise<ContentSource> {
  const { source, parseErrors } = await loadContentDir(CONTENT_DIR);
  expect(parseErrors).toEqual([]);
  return structuredClone(source);
}

const codes = (src: ContentSource) => validateContent(src).issues.filter((i) => i.severity === "error").map((i) => i.code);

describe("the content in /content", () => {
  it("is valid", async () => {
    const result = validateContent(await realSource());
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("has every task type in every module", async () => {
    const result = validateContent(await realSource());
    for (const set of result.content!.taskSets) {
      expect(new Set(set.tasks.map((t) => t.type))).toEqual(new Set(["choice", "gap_fill", "transform", "order_words"]));
    }
  });

  it("builds a bundle whose hash depends on content only", async () => {
    const content = validateContent(await realSource()).content!;
    const a = buildBundle(content, new Date("2026-01-01"));
    const b = buildBundle(content, new Date("2026-06-01"));
    expect(a.content_hash).toBe(b.content_hash);
    expect(Object.keys(a.tasks).length).toBeGreaterThanOrEqual(36);
    expect(a.tasks["A1_PastSimple_01_q3"]?.module_id).toBe("A1_PastSimple_01");
  });
});

describe("validator catches", () => {
  it("a task pointing at a concept its module does not define", async () => {
    const src = await realSource();
    (src.taskSets[0]!.data as any).tasks[0].concept_id = "nope.missing";
    expect(codes(src)).toContain("ref.concept");
  });

  it("a prerequisite cycle", async () => {
    const src = await realSource();
    const verbToBe = src.modules.find((m) => (m.data as any).module_id === "A1_VerbToBe_01")!;
    (verbToBe.data as any).prerequisites = ["A1_PastSimple_01"];
    expect(codes(src)).toContain("cycle.prerequisites");
  });

  it("a duplicate task id", async () => {
    const src = await realSource();
    const tasks = (src.taskSets[0]!.data as any).tasks;
    tasks.push(structuredClone(tasks[0]));
    expect(codes(src)).toContain("duplicate.task_id");
  });

  it("a track that puts a module before its prerequisite", async () => {
    const src = await realSource();
    const steps = (src.tracks[0]!.data as any).chapters[0].steps;
    steps.reverse();
    expect(codes(src)).toContain("order.prerequisites");
  });

  it("a track reordering that respects prerequisites is fine", async () => {
    const src = await realSource();
    const steps = (src.tracks[0]!.data as any).chapters[0].steps;
    // VerbToBe, PastSimple, Articles → VerbToBe, Articles, PastSimple
    [steps[1], steps[2]] = [steps[2], steps[1]];
    expect(codes(src)).toEqual([]);
  });

  it("an unknown error type in known_errors", async () => {
    const src = await realSource();
    const task = (src.taskSets[0]!.data as any).tasks.find((t: any) => t.answer.known_errors?.length);
    task.answer.known_errors[0].error_type = "grammar.made_up";
    expect(codes(src)).toContain("ref.error_type");
  });

  it("an answer that is both accepted and a known error", async () => {
    const src = await realSource();
    const task = (src.taskSets[0]!.data as any).tasks.find((t: any) => t.type === "gap_fill" && t.answer.known_errors?.length);
    task.answer.known_errors[0].match.push(task.answer.accepted[0].toUpperCase());
    expect(codes(src)).toContain("answer.conflict");
  });

  it("an order_words answer that cannot be built from its tokens", async () => {
    const src = await realSource();
    const task = (src.taskSets[0]!.data as any).tasks.find((t: any) => t.type === "order_words");
    task.answer.accepted = ["Something else entirely"];
    expect(codes(src)).toContain("answer.tokens");
  });

  it("schema violations, with the offending field", async () => {
    const src = await realSource();
    (src.modules[0]!.data as any).cefr_level = "Z9";
    (src.modules[0]!.data as any).surprise = true;
    const issues = validateContent(src).issues;
    expect(issues.some((i) => i.code === "schema" && i.message.includes("cefr_level"))).toBe(true);
    expect(issues.some((i) => i.code === "schema" && i.message.includes("surprise"))).toBe(true);
  });

  it("a boss that is not a boss", async () => {
    const src = await realSource();
    (src.tracks[0]!.data as any).chapters[0].steps[0].boss = "gate_rat";
    expect(codes(src)).toContain("ref.enemy");
  });

  it("a boss among ordinary encounters and a missing story", async () => {
    const src = await realSource();
    const step = (src.tracks[0]!.data as any).chapters[0].steps[0];
    step.encounters.enemies = ["ash_golem"];
    step.outro = "no_such_story";
    expect(codes(src)).toEqual(expect.arrayContaining(["ref.enemy", "ref.story"]));
  });

  it("a level curve that does not grow and a boss on patrol", async () => {
    const src = await realSource();
    const rules = src.progression![0]!.data as any;
    rules.levels.xp_to_reach = [0, 100, 100];
    rules.patrol.enemies = ["ash_golem"];
    expect(codes(src)).toEqual(expect.arrayContaining(["progression.levels", "ref.enemy"]));
  });

  it("a repair threshold outside 0..1", async () => {
    const src = await realSource();
    (src.progression![0]!.data as any).repair.threshold = 1.2;
    expect(codes(src)).toContain("schema");
  });

  it("but accepts content without progression rules", async () => {
    const src = await realSource();
    delete src.progression;
    expect(validateContent(src).ok).toBe(true);
  });
});

describe("findCycles", () => {
  it("finds a three-node cycle and ignores acyclic parts", () => {
    const graph = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]], ["d", ["a"]]]);
    expect(findCycles(graph)).toEqual([["a", "b", "c"]]);
  });
});

describe("normalizeAnswer", () => {
  it("unifies apostrophes, case, spaces and trailing punctuation", () => {
    expect(normalizeAnswer("  We  AREN’T afraid. ")).toBe("we aren't afraid");
    expect(normalizeAnswer("Are you a friend ?")).toBe("are you a friend");
    expect(normalizeAnswer("Went", true)).toBe("Went");
  });
});
