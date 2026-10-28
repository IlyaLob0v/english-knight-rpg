// Node-only: writes an imported sheet into the content folder as the same JSON files Ilya edits by hand.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { SheetContent } from "./import.js";

const SCHEMAS = fileURLToPath(new URL("../../schemas/", import.meta.url));

/**
 * JSON the way the content files are written by hand: a value that fits on one line stays on
 * one line, anything longer opens up.
 */
export function prettyJson(value: unknown, width = 140): string {
  const flat = (v: unknown): string => {
    if (Array.isArray(v)) return v.length ? `[${v.map(flat).join(", ")}]` : "[]";
    if (v !== null && typeof v === "object") {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      return entries.length ? `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${flat(x)}`).join(", ")} }` : "{}";
    }
    return JSON.stringify(v) ?? "null";
  };
  const render = (v: unknown, indent: string, used: number): string => {
    const one = flat(v);
    if (v === null || typeof v !== "object" || used + one.length <= width) return one;
    const inner = indent + "  ";
    if (Array.isArray(v)) return `[\n${v.map((x) => inner + render(x, inner, inner.length)).join(",\n")}\n${indent}]`;
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${render(x, inner, inner.length + k.length + 4)}`).join(",\n")}\n${indent}}`;
  };
  return render(value, "", 0) + "\n";
}

async function jsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Replaces units, tasks, episodes and places in the content folder with the sheet's, and sets the
 * course's unit order. Files of units that left the sheet are removed. Returns the files written.
 */
export async function writeSheetToDir(root: string, sheet: SheetContent): Promise<string[]> {
  const written: string[] = [];
  const put = async (path: string, schema: string, data: object) => {
    await mkdir(dirname(path), { recursive: true });
    const $schema = relative(dirname(path), join(SCHEMAS, schema)).split("\\").join("/");
    await writeFile(path, prettyJson({ $schema, ...data }));
    written.push(relative(root, path));
  };
  const keep = new Set<string>();
  for (const m of sheet.modules) {
    const path = join(root, "modules", `${m.module_id}.json`);
    keep.add(path);
    await put(path, "module.schema.json", m);
  }
  for (const s of sheet.taskSets) {
    const path = join(root, "tasks", `${s.module_id}.json`);
    keep.add(path);
    await put(path, "task-set.schema.json", s);
  }
  for (const e of sheet.episodes) {
    const path = join(root, "moonbridge", "episodes", `${e.episode_id}.json`);
    keep.add(path);
    await put(path, "episode.schema.json", e);
  }
  await put(join(root, "moonbridge", "places.json"), "places.schema.json", { schema_version: "2.0", places: sheet.places });
  for (const dir of ["modules", "tasks", join("moonbridge", "episodes")]) {
    for (const f of await jsonFiles(join(root, dir))) if (!keep.has(f)) await rm(f);
  }
  const [course] = (await jsonFiles(join(root, "courses"))).sort();
  if (course) {
    const { $schema: _, ...data } = JSON.parse(await readFile(course, "utf8")) as Record<string, unknown>;
    await put(course, "course.schema.json", { ...data, units: sheet.units });
  }
  return written;
}
