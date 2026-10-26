import { validateContent, type ContentBundle, type Task } from "@knight/content";
import { buildBundle, loadContentDir } from "@knight/content/node";

const CONTENT_DIR = new URL("../../../content", import.meta.url).pathname;

export async function loadBundle(): Promise<ContentBundle> {
  const { source } = await loadContentDir(CONTENT_DIR);
  const result = validateContent(source);
  if (!result.content) throw new Error(JSON.stringify(result.issues, null, 2));
  return buildBundle(result.content);
}

/** Answers that are right, a known error, a typo or nonsense, for any task of the bundle. */
export function answerFor(task: Task, kind: "right" | "wrong"): string | string[] {
  if (kind === "right") return task.type === "order_words" ? task.answer.accepted[0]!.split(" ") : task.answer.accepted[0]!;
  if (task.type === "choice") return task.presentation.options!.find((o) => !task.answer.accepted.includes(o.id))!.id;
  if (task.type === "order_words") return [...task.presentation.tokens!].reverse();
  return "zzzz qqqq";
}
