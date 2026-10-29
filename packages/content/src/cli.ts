import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateContent } from "./validate.js";
import { buildBundle, loadContentDir } from "./node.js";
import { checkSheet, contentToSheet, fetchGoogleSheet, readXlsx, writeXlsx } from "./sheet/index.js";
import { writeSheetToDir } from "./sheet/files.js";

const [command, rootArg, outArg] = process.argv.slice(2);
const USAGE = `usage: cli.ts validate <content-dir>
       cli.ts bundle <content-dir> <out.json>
       cli.ts export <content-dir> <out.xlsx>            the content as the teacher's sheet
       cli.ts import <content-dir> <file.xlsx | Google Sheets link>   the sheet back into JSON files`;

async function main(): Promise<number> {
  if (!["validate", "bundle", "export", "import"].includes(command ?? "") || !rootArg) {
    console.error(USAGE);
    return 2;
  }
  const root = resolve(rootArg);
  if (command === "import") return importSheet(root, outArg);
  const { source, parseErrors } = await loadContentDir(root);
  for (const p of parseErrors) console.error(`✗ ${p.file}: invalid JSON: ${p.message}`);

  const result = validateContent(source);
  for (const issue of result.issues) {
    const mark = issue.severity === "error" ? "✗" : "!";
    console.error(`${mark} ${issue.file} [${issue.code}] ${issue.message}`);
  }
  const errors = result.issues.filter((i) => i.severity === "error").length + parseErrors.length;
  const warnings = result.issues.length - (errors - parseErrors.length);
  if (errors > 0 || !result.content) {
    console.error(`\nContent invalid: ${errors} error(s), ${warnings} warning(s).`);
    return 1;
  }
  const bundle = buildBundle(result.content);
  const counts = `${bundle.modules.length} units, ${Object.keys(bundle.tasks).length} tasks, ${bundle.courses.length} course(s), ${
    bundle.moonbridge
      ? `${bundle.moonbridge.episodes.length} Moonbridge episode(s), ${bundle.moonbridge.daily?.guests.length ?? 0} guest(s) of the day`
      : "no Moonbridge"
  }`;
  if (command === "export") {
    const out = resolve(outArg ?? "moonbridge-content.xlsx");
    const { book, layout } = contentToSheet(result.content);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, writeXlsx(book, layout));
    console.log(`Sheet written to ${out} (${counts}).`);
    return 0;
  }
  if (command === "validate") {
    console.log(`Content OK: ${counts}, ${warnings} warning(s), hash ${bundle.content_hash}.`);
    return 0;
  }
  const out = resolve(outArg ?? "content-bundle.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(bundle, null, 2) + "\n");
  console.log(`Bundle ${bundle.content_hash} written to ${out} (${counts}).`);
  return 0;
}

/** Reads a sheet, checks it against the folder's other content and, when valid, rewrites the folder's JSON. */
async function importSheet(root: string, from: string | undefined): Promise<number> {
  if (!from) {
    console.error(USAGE);
    return 2;
  }
  const data = from.startsWith("https://") ? await fetchGoogleSheet(from) : await readFile(resolve(from));
  const { source } = await loadContentDir(root);
  const live = validateContent(source).content;
  const result = checkSheet(readXlsx(data), source, live ? { modules: live.modules, tasks: live.taskSets.flatMap((s) => s.tasks) } : undefined);
  for (const issue of result.issues) console.error(`${issue.severity === "error" ? "✗" : "!"} ${issue.where}: ${issue.message}`);
  if (!result.ok || !result.sheet) {
    console.error("\nThe sheet has errors; nothing was written.");
    return 1;
  }
  const written = await writeSheetToDir(root, result.sheet);
  console.log(`Imported ${result.sheet.modules.length} units, ${result.sheet.taskSets.reduce((n, s) => n + s.tasks.length, 0)} tasks, ${result.sheet.episodes.length} episodes: ${written.length} files written.`);
  return 0;
}

process.exitCode = await main();
