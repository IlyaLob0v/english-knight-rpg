import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import moduleSchema from "../schemas/module.schema.json" with { type: "json" };
import taskSetSchema from "../schemas/task-set.schema.json" with { type: "json" };
import trackSchema from "../schemas/track.schema.json" with { type: "json" };
import buildingsSchema from "../schemas/buildings.schema.json" with { type: "json" };
import enemiesSchema from "../schemas/enemies.schema.json" with { type: "json" };
import errorsSchema from "../schemas/errors.schema.json" with { type: "json" };
import { normalizeAnswer, tokenize } from "./normalize.js";
import type {
  Building,
  ContentSource,
  Enemy,
  ErrorTaxonomy,
  Module,
  SourceFile,
  Task,
  TaskSet,
  Track,
} from "./types.js";

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  file: string;
  /** Stable machine-readable code, e.g. "ref.concept" or "cycle.prerequisites". */
  code: string;
  message: string;
}

export interface ValidatedContent {
  taxonomy: ErrorTaxonomy;
  modules: Module[];
  taskSets: TaskSet[];
  tracks: Track[];
  buildings: Building[];
  enemies: Enemy[];
}

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
  /** Present only when ok: the content, typed. */
  content?: ValidatedContent;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
const validators = {
  module: ajv.compile(moduleSchema),
  taskSet: ajv.compile(taskSetSchema),
  track: ajv.compile(trackSchema),
  buildings: ajv.compile(buildingsSchema),
  enemies: ajv.compile(enemiesSchema),
  errors: ajv.compile(errorsSchema),
};

function schemaPass<T>(files: SourceFile[], validate: ValidateFunction, issues: Issue[]): SourceFile<T>[] {
  const valid: SourceFile<T>[] = [];
  for (const file of files) {
    if (validate(file.data)) {
      valid.push(file as SourceFile<T>);
      continue;
    }
    for (const err of validate.errors ?? []) {
      issues.push({
        severity: "error",
        file: file.path,
        code: "schema",
        message: `${err.instancePath || "/"} ${err.message ?? "is invalid"}${
          err.params && "allowedValues" in err.params ? `: ${JSON.stringify(err.params.allowedValues)}` : ""
        }${err.params && "additionalProperty" in err.params ? `: "${String(err.params.additionalProperty)}"` : ""}`,
      });
    }
  }
  return valid;
}

/**
 * Validates content in two passes: JSON Schema per file, then cross-file checks
 * (references, cycles, duplicates, answer consistency). Any error fails the build;
 * warnings are reported but do not block.
 */
export function validateContent(source: ContentSource): ValidationResult {
  const issues: Issue[] = [];
  const err = (file: string, code: string, message: string) => issues.push({ severity: "error", file, code, message });
  const warn = (file: string, code: string, message: string) => issues.push({ severity: "warning", file, code, message });

  const taxonomyFiles = schemaPass<ErrorTaxonomy>(source.taxonomy, validators.errors, issues);
  const moduleFiles = schemaPass<Module>(source.modules, validators.module, issues);
  const taskSetFiles = schemaPass<TaskSet>(source.taskSets, validators.taskSet, issues);
  const trackFiles = schemaPass<Track>(source.tracks, validators.track, issues);
  const buildingFiles = schemaPass<{ buildings: Building[] }>(source.buildings, validators.buildings, issues);
  const enemyFiles = schemaPass<{ enemies: Enemy[] }>(source.enemies, validators.enemies, issues);

  if (source.taxonomy.length !== 1) {
    err("taxonomy/", "taxonomy.count", `expected exactly one error taxonomy file, found ${source.taxonomy.length}`);
  }
  // Cross-file checks only make sense on schema-valid data; stop here otherwise.
  if (issues.some((i) => i.severity === "error")) return { ok: false, issues };

  const taxonomy = taxonomyFiles[0]!.data;
  const errorTypes = new Set<string>();
  for (const et of taxonomy.error_types) {
    if (errorTypes.has(et.id)) err(taxonomyFiles[0]!.path, "duplicate.error_type", `error type "${et.id}" is defined twice`);
    errorTypes.add(et.id);
  }
  if (!errorTypes.has("unclassified")) err(taxonomyFiles[0]!.path, "taxonomy.unclassified", `taxonomy must define "unclassified"`);

  // Modules and concepts.
  const modules = new Map<string, { file: string; module: Module }>();
  const conceptOwner = new Map<string, string>();
  for (const { path, data: m } of moduleFiles) {
    if (modules.has(m.module_id)) {
      err(path, "duplicate.module_id", `module "${m.module_id}" is also defined in ${modules.get(m.module_id)!.file}`);
      continue;
    }
    modules.set(m.module_id, { file: path, module: m });
    for (const c of m.concepts) {
      const owner = conceptOwner.get(c.concept_id);
      if (owner) err(path, "duplicate.concept_id", `concept "${c.concept_id}" is already defined in module "${owner}"`);
      else conceptOwner.set(c.concept_id, m.module_id);
    }
  }
  for (const { file, module: m } of modules.values()) {
    for (const p of m.prerequisites) {
      if (p === m.module_id) err(file, "cycle.prerequisites", `module "${p}" lists itself as a prerequisite`);
      else if (!modules.has(p)) err(file, "ref.module", `prerequisite "${p}" does not exist`);
    }
  }
  for (const cycle of findCycles(new Map([...modules].map(([id, { module }]) => [id, module.prerequisites])))) {
    err(modules.get(cycle[0]!)!.file, "cycle.prerequisites", `prerequisite cycle: ${[...cycle, cycle[0]].join(" → ")}`);
  }

  // Tasks.
  const tasks = new Map<string, { file: string; module_id: string; task: Task }>();
  const taskSetByModule = new Map<string, string>();
  for (const { path, data: set } of taskSetFiles) {
    const mod = modules.get(set.module_id);
    if (!mod) {
      err(path, "ref.module", `task set refers to unknown module "${set.module_id}"`);
      continue;
    }
    if (taskSetByModule.has(set.module_id)) {
      err(path, "duplicate.task_set", `module "${set.module_id}" already has a task set in ${taskSetByModule.get(set.module_id)}`);
    }
    taskSetByModule.set(set.module_id, path);
    const moduleConcepts = new Set(mod.module.concepts.map((c) => c.concept_id));
    for (const task of set.tasks) {
      const where = `${path} › ${task.task_id}`;
      if (tasks.has(task.task_id)) {
        err(path, "duplicate.task_id", `task "${task.task_id}" is also defined in ${tasks.get(task.task_id)!.file}`);
        continue;
      }
      tasks.set(task.task_id, { file: path, module_id: set.module_id, task });
      if (!task.task_id.startsWith(`${set.module_id}_`)) {
        err(where, "id.task_prefix", `task id must start with its module id "${set.module_id}_"`);
      }
      if (!moduleConcepts.has(task.concept_id)) {
        err(where, "ref.concept", `concept "${task.concept_id}" is not defined in module "${set.module_id}"`);
      }
      checkAnswer(task, where, errorTypes, err, warn);
    }
  }
  for (const { file, module: m } of modules.values()) {
    const pool = m.tasks.filter((id) => {
      const t = tasks.get(id);
      if (!t) err(file, "ref.task", `task "${id}" is not defined in any task set`);
      else if (t.module_id !== m.module_id) err(file, "ref.task", `task "${id}" belongs to module "${t.module_id}"`);
      return t?.module_id === m.module_id;
    });
    if (pool.length < m.mastery.boss_task_count) {
      err(file, "mastery.pool", `boss needs ${m.mastery.boss_task_count} tasks but the pool has ${pool.length}`);
    }
    const conceptsWithTasks = new Set(pool.map((id) => tasks.get(id)!.task.concept_id));
    for (const c of m.concepts) {
      if (!conceptsWithTasks.has(c.concept_id)) err(file, "concept.no_tasks", `concept "${c.concept_id}" has no active tasks`);
    }
  }
  for (const [id, t] of tasks) {
    if (!modules.get(t.module_id)?.module.tasks.includes(id)) {
      warn(t.file, "task.inactive", `task "${id}" is not in module "${t.module_id}" task pool and will not be used`);
    }
  }

  // World.
  const buildings = collectUnique(buildingFiles, (d) => d.buildings, (b) => b.building_id, "building_id", err);
  const enemies = collectUnique(enemyFiles, (d) => d.enemies, (e) => e.enemy_id, "enemy_id", err);

  // Tracks: references and prerequisite order.
  const trackIds = new Set<string>();
  for (const { path, data: track } of trackFiles) {
    if (trackIds.has(track.track_id)) err(path, "duplicate.track_id", `track "${track.track_id}" is defined twice`);
    trackIds.add(track.track_id);
    const seen = new Set<string>();
    const buildingsUsed = new Set<string>();
    for (const chapter of track.chapters) {
      for (const step of chapter.steps) {
        const where = `${path} › ${chapter.chapter_id} › ${step.module_id}`;
        const mod = modules.get(step.module_id);
        if (!mod) err(where, "ref.module", `module "${step.module_id}" does not exist`);
        if (seen.has(step.module_id)) err(where, "duplicate.track_step", `module "${step.module_id}" appears twice in the track`);
        for (const p of mod?.module.prerequisites ?? []) {
          if (!seen.has(p)) {
            err(where, "order.prerequisites", `prerequisite "${p}" must come earlier in the track than "${step.module_id}"`);
          }
        }
        seen.add(step.module_id);
        if (!buildings.has(step.unlocks_building)) err(where, "ref.building", `building "${step.unlocks_building}" does not exist`);
        if (buildingsUsed.has(step.unlocks_building)) {
          err(where, "duplicate.building", `building "${step.unlocks_building}" is unlocked by two steps`);
        }
        buildingsUsed.add(step.unlocks_building);
        if (step.boss !== undefined) {
          const enemy = enemies.get(step.boss);
          if (!enemy) err(where, "ref.enemy", `boss "${step.boss}" does not exist`);
          else if (enemy.role !== "boss") err(where, "ref.enemy", `enemy "${step.boss}" has role "${enemy.role}", expected "boss"`);
        }
      }
    }
  }

  const ok = !issues.some((i) => i.severity === "error");
  return {
    ok,
    issues,
    content: ok
      ? {
          taxonomy,
          modules: [...modules.values()].map((m) => m.module),
          taskSets: taskSetFiles.map((f) => f.data),
          tracks: trackFiles.map((f) => f.data),
          buildings: [...buildings.values()],
          enemies: [...enemies.values()],
        }
      : undefined,
  };
}

function checkAnswer(
  task: Task,
  where: string,
  errorTypes: Set<string>,
  err: (file: string, code: string, message: string) => void,
  warn: (file: string, code: string, message: string) => void,
) {
  const cs = task.answer.case_sensitive ?? false;
  const accepted = new Set(task.answer.accepted.map((a) => normalizeAnswer(a, cs)));
  const known = task.answer.known_errors ?? [];

  for (const ke of known) {
    if (!errorTypes.has(ke.error_type)) err(where, "ref.error_type", `error type "${ke.error_type}" is not in the taxonomy`);
    for (const m of ke.match) {
      if (accepted.has(normalizeAnswer(m, cs))) err(where, "answer.conflict", `"${m}" is both accepted and a known error`);
    }
  }

  if (task.type === "choice") {
    const optionIds = new Set(task.presentation.options?.map((o) => o.id));
    if (optionIds.size !== task.presentation.options?.length) err(where, "answer.options", "option ids must be unique");
    for (const a of task.answer.accepted) {
      if (!optionIds.has(a)) err(where, "answer.option_ref", `accepted "${a}" is not an option id`);
    }
    for (const ke of known) {
      for (const m of ke.match) if (!optionIds.has(m)) err(where, "answer.option_ref", `known error "${m}" is not an option id`);
    }
    const coveredWrong = new Set(known.flatMap((k) => k.match));
    const uncovered = [...optionIds].filter((id) => !accepted.has(id) && !coveredWrong.has(id));
    if (uncovered.length) warn(where, "answer.untagged_option", `wrong options without an error type: ${uncovered.join(", ")}`);
  }

  if (task.type === "order_words") {
    const tokens = tokenize(task.presentation.tokens!.join(" ")).sort().join(" ");
    for (const a of task.answer.accepted) {
      if (tokenize(a).sort().join(" ") !== tokens) {
        err(where, "answer.tokens", `accepted "${a}" cannot be built from the given tokens`);
      }
    }
  }

  if (task.type === "gap_fill" && !task.presentation.prompt.includes("___")) {
    err(where, "presentation.gap", 'gap_fill prompt must contain a "___" gap');
  }
}

function collectUnique<D, T>(
  files: SourceFile<D>[],
  items: (d: D) => T[],
  idOf: (t: T) => string,
  label: string,
  err: (file: string, code: string, message: string) => void,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const { path, data } of files) {
    for (const item of items(data)) {
      const id = idOf(item);
      if (out.has(id)) err(path, `duplicate.${label}`, `${label} "${id}" is defined twice`);
      else out.set(id, item);
    }
  }
  return out;
}

/** Returns each elementary cycle once (as found by DFS) in a dependency graph. */
export function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (node: string) => {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next) || next === node) continue;
      const s = state.get(next);
      if (s === "visiting") cycles.push(stack.slice(stack.indexOf(next)));
      else if (s === undefined) visit(next);
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return cycles;
}
