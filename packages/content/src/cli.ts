import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateContent } from "./validate.js";
import { buildBundle, loadContentDir } from "./node.js";

const [command, rootArg, outArg] = process.argv.slice(2);

async function main(): Promise<number> {
  if ((command !== "validate" && command !== "bundle") || !rootArg) {
    console.error("usage: cli.ts validate <content-dir> | bundle <content-dir> <out.json>");
    return 2;
  }
  const root = resolve(rootArg);
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

process.exitCode = await main();
