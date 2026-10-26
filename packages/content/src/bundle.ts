import { createHash } from "node:crypto";
import type { ContentBundle, Task } from "./types.js";
import type { ValidatedContent } from "./validate.js";

/**
 * Flattens validated content into the bundle the game loads. The hash covers the
 * content only (not the build time), so an unchanged content tree gives the same hash.
 */
export function buildBundle(content: ValidatedContent, builtAt = new Date()): ContentBundle {
  const tasks: Record<string, Task & { module_id: string }> = {};
  for (const set of content.taskSets) {
    for (const task of set.tasks) tasks[task.task_id] = { ...task, module_id: set.module_id };
  }
  const body = {
    taxonomy: content.taxonomy,
    modules: [...content.modules].sort((a, b) => a.module_id.localeCompare(b.module_id)),
    tasks: Object.fromEntries(Object.entries(tasks).sort(([a], [b]) => a.localeCompare(b))),
    tracks: [...content.tracks].sort((a, b) => a.track_id.localeCompare(b.track_id)),
    buildings: [...content.buildings].sort((a, b) => a.building_id.localeCompare(b.building_id)),
    enemies: [...content.enemies].sort((a, b) => a.enemy_id.localeCompare(b.enemy_id)),
  };
  const content_hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { bundle_schema_version: "1.0", content_hash, built_at: builtAt.toISOString(), ...body };
}
