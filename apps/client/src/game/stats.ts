import type { ContentBundle } from "@knight/content";
import { errorStats, type Attempt, type ConceptScheduler } from "@knight/learning";

export interface ErrorReport {
  /** Period in days, or undefined for all time. */
  days?: number;
  total: number;
  correct: number;
  topErrorTypes: { id: string; label: string; count: number }[];
  /** Concepts with at least one attempt, most errors first. */
  concepts: { conceptId: string; label: string; moduleTitle: string; attempts: number; errors: number; retrievability?: number }[];
  /** Wrong answers no rule recognised: what to add to known_errors next. */
  unclassified: { taskId: string; moduleTitle: string; prompt: string; response: string; correctForm: string; count: number }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The statistics screen, built from the attempt journal: the same records the
 * xAPI "answered" statements are built from, so the screen and the LRS agree.
 */
export function errorReport(
  bundle: ContentBundle,
  attempts: Attempt[],
  scheduler: ConceptScheduler,
  o: { now: Date; days?: number; top?: number },
): ErrorReport {
  const since = o.days !== undefined ? o.now.getTime() - o.days * DAY_MS : -Infinity;
  const stats = errorStats(attempts.filter((a) => Date.parse(a.timestamp) >= since), o.top ?? 5);
  const labels = new Map(bundle.taxonomy.error_types.map((t) => [t.id, t.label.ru]));
  const concepts = new Map(bundle.modules.flatMap((m) => m.concepts.map((c) => [c.concept_id, { label: c.label, moduleTitle: m.title.ru }] as const)));
  const moduleTitles = new Map(bundle.modules.map((m) => [m.module_id, m.title.ru]));

  return {
    ...(o.days !== undefined ? { days: o.days } : {}),
    total: stats.total,
    correct: stats.correct,
    topErrorTypes: stats.topErrorTypes.map((t) => ({ id: t.error_type, label: labels.get(t.error_type) ?? t.error_type, count: t.count })),
    concepts: Object.entries(stats.byConcept)
      .map(([conceptId, c]) => {
        const r = scheduler.retrievability(conceptId, o.now);
        return {
          conceptId,
          label: concepts.get(conceptId)?.label ?? conceptId,
          moduleTitle: concepts.get(conceptId)?.moduleTitle ?? "",
          attempts: c.attempts,
          errors: c.errors,
          ...(r !== undefined ? { retrievability: r } : {}),
        };
      })
      .sort((a, b) => b.errors - a.errors || b.errors / b.attempts - a.errors / a.attempts || a.conceptId.localeCompare(b.conceptId)),
    unclassified: stats.unclassified.map((u) => {
      const task = bundle.tasks[u.task_id];
      const first = task?.answer.accepted[0] ?? "";
      const option = (id: string) => task?.presentation.options?.find((o) => o.id === id)?.text ?? id;
      return {
        taskId: u.task_id,
        moduleTitle: task ? (moduleTitles.get(task.module_id) ?? "") : "",
        prompt: task?.presentation.prompt ?? "",
        response: task?.type === "choice" ? option(u.response) : u.response,
        correctForm: task?.type === "choice" ? option(first) : first,
        count: u.count,
      };
    }),
  };
}
