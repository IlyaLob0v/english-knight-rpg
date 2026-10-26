import type { ContentBundle, Task } from "@knight/content";
import type { ConceptScheduler } from "./scheduler.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Active tasks (in the module pool) per concept, in pool order. */
export function tasksByConcept(bundle: ContentBundle): Map<string, Task[]> {
  const out = new Map<string, Task[]>();
  for (const m of bundle.modules) {
    for (const id of m.tasks) {
      const t = bundle.tasks[id];
      if (!t) continue;
      (out.get(t.concept_id) ?? out.set(t.concept_id, []).get(t.concept_id)!).push(t);
    }
  }
  return out;
}

export interface PickOptions {
  /** When each task was last shown, epoch ms. */
  lastSeen: Map<string, number>;
  now: number;
  /** A task is not repeated within this window if the concept has any other choice. */
  cooldownDays?: number;
  exclude?: Set<string>;
  random?: () => number;
}

/** Picks a task for a concept: a random one not seen within the cooldown, else the least recently seen. */
export function pickTask(pool: Task[], o: PickOptions): Task | undefined {
  const cooldown = (o.cooldownDays ?? 3) * DAY_MS;
  const candidates = pool.filter((t) => !o.exclude?.has(t.task_id));
  if (candidates.length === 0) return undefined;
  const fresh = candidates.filter((t) => {
    const seen = o.lastSeen.get(t.task_id);
    return seen === undefined || o.now - seen >= cooldown;
  });
  if (fresh.length) return fresh[Math.floor((o.random ?? Math.random)() * fresh.length)];
  return [...candidates].sort((a, b) => (o.lastSeen.get(a.task_id) ?? 0) - (o.lastSeen.get(b.task_id) ?? 0))[0];
}

export interface PatrolOptions {
  /** Modules whose concepts may appear (unlocked in the city). */
  moduleIds: string[];
  lastSeen: Map<string, number>;
  now: Date;
  size?: number;
  random?: () => number;
}

/**
 * The daily patrol: tasks for concepts that FSRS says are due, weakest first,
 * round-robin so one weak concept does not take the whole patrol. If fewer
 * concepts are due than slots, the weakest studied concepts top it up.
 */
export function buildPatrol(bundle: ContentBundle, scheduler: ConceptScheduler, o: PatrolOptions): Task[] {
  const size = o.size ?? 12;
  const pools = tasksByConcept(bundle);
  const allowed = bundle.modules.filter((m) => o.moduleIds.includes(m.module_id)).flatMap((m) => m.concepts.map((c) => c.concept_id));
  const studied = allowed.filter((id) => scheduler.has(id));
  const due = scheduler.due(o.now, studied);
  const rest = studied
    .filter((id) => !due.includes(id))
    .sort((a, b) => (scheduler.retrievability(a, o.now) ?? 0) - (scheduler.retrievability(b, o.now) ?? 0));
  const order = [...due, ...rest];
  if (order.length === 0) return [];

  const picked: Task[] = [];
  const used = new Set<string>();
  for (let round = 0; picked.length < size; round++) {
    let progressed = false;
    for (const conceptId of order) {
      if (picked.length >= size) break;
      const task = pickTask(pools.get(conceptId) ?? [], {
        lastSeen: o.lastSeen,
        now: o.now.getTime(),
        exclude: used,
        ...(o.random ? { random: o.random } : {}),
      });
      if (!task) continue;
      picked.push(task);
      used.add(task.task_id);
      progressed = true;
    }
    if (!progressed) break;
  }
  return picked;
}
