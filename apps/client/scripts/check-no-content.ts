// CI guard for the main rule of the repo: the client contains no course content.
// Fails if any task prompt, option, multi-word answer, hint, feedback or story line
// from /content appears in apps/client/src.
import { validateContent } from "@knight/content";
import { loadContentDir } from "@knight/content/node";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("../../..", import.meta.url).pathname;
const srcDir = join(root, "apps/client/src");

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(full)));
    else if (/\.(ts|tsx|js|json|html|css)$/.test(e.name)) out.push(full);
  }
  return out;
}

const { source } = await loadContentDir(join(root, "content"));
const result = validateContent(source);
if (!result.content) {
  console.error("content is invalid; run pnpm content:validate");
  process.exit(1);
}

// Needles: phrases specific enough that finding one in code means content was copied there.
const needles = new Map<string, string>();
const add = (text: string | undefined, where: string) => {
  if (!text) return;
  for (const part of text.split("___")) {
    const s = squash(part);
    if (s.split(" ").length >= 3 || (s.split(" ").length >= 2 && s.length >= 12)) needles.set(s, where);
  }
};
for (const set of result.content.taskSets) {
  for (const t of set.tasks) {
    const where = `task ${t.task_id}`;
    add(t.presentation.prompt, where);
    add(t.presentation.hint, where);
    add(t.presentation.source, where);
    for (const o of t.presentation.options ?? []) add(o.text, where);
    for (const a of t.answer.accepted) add(a, where);
    for (const k of t.answer.known_errors ?? []) add(k.feedback, where);
  }
}
for (const story of result.content.stories) for (const line of story.lines) add(line.text.en, `story ${story.story_id}`);

let found = 0;
for (const file of await files(srcDir)) {
  const text = squash(await readFile(file, "utf8"));
  for (const [needle, where] of needles) {
    if (text.includes(needle)) {
      console.error(`✗ ${relative(root, file)} contains "${needle}" from ${where}`);
      found++;
    }
  }
}
if (found) {
  console.error(`\n${found} piece(s) of course content found in the client. Content belongs in /content, not in code.`);
  process.exit(1);
}
console.log(`No course content in apps/client/src (${needles.size} phrases checked).`);
