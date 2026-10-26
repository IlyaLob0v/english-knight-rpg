import type { Building, Concept, ContentBundle, Module, Progression, Track, TrackStep } from "@knight/content";
import type { ConceptScheduler } from "@knight/learning";
import { moduleProgress, type PlayerProgress } from "./progress.js";
import { NO_BONUSES, type CityBonuses } from "./rules.js";

/**
 * locked: its module is not passed yet; site: the boss fell, the building can be
 * built for KP; built: standing and giving its bonus; damaged: a concept of its
 * module is fading, no bonus until repaired.
 */
export type BuildingState = "locked" | "site" | "built" | "damaged";

export interface ConceptHealth {
  concept: Concept;
  /** Recall probability now, 0..1; undefined if never practised. */
  retrievability?: number;
  /** A crack: below the repair threshold, or, in a building already cracked, last answered wrong. */
  weak: boolean;
}

export interface BuildingView {
  building: Building;
  step: TrackStep;
  module: Module;
  state: BuildingState;
  /** Enough KP to build it (meaningful for a site). */
  affordable: boolean;
  concepts: ConceptHealth[];
}

/**
 * The city as the track defines it: one plot per track step, holding the building
 * that step unlocks. Which module repairs a building is whatever the track says now.
 *
 * Recall probability alone cannot tell a repair from a failed one: FSRS puts it
 * near 1 right after any review, wrong answers included. So once a building is
 * known to be cracked, a concept stays cracked until its latest answer is right.
 */
export function cityView(
  bundle: ContentBundle,
  track: Track,
  progress: PlayerProgress,
  scheduler: ConceptScheduler,
  rules: Progression,
  now: Date,
  /** Whether the latest answer for each concept was right. */
  lastCorrect: ReadonlyMap<string, boolean> = new Map(),
): BuildingView[] {
  const buildings = new Map(bundle.buildings.map((b) => [b.building_id, b]));
  const modules = new Map(bundle.modules.map((m) => [m.module_id, m]));
  const out: BuildingView[] = [];
  for (const step of track.chapters.flatMap((c) => c.steps)) {
    const building = buildings.get(step.unlocks_building);
    const module = modules.get(step.module_id);
    if (!building || !module) continue;
    const stored = progress.buildings[building.building_id];
    const concepts = module.concepts.map((concept) => {
      const r = scheduler.retrievability(concept.concept_id, now);
      const weak = r !== undefined && (r < rules.repair.threshold || (!!stored?.damaged && lastCorrect.get(concept.concept_id) === false));
      return { concept, ...(r !== undefined ? { retrievability: r } : {}), weak };
    });
    const built = !!stored;
    const state: BuildingState = built
      ? concepts.some((c) => c.weak)
        ? "damaged"
        : "built"
      : moduleProgress(progress, module.module_id).bossPassed
        ? "site"
        : "locked";
    out.push({ building, step, module, state, affordable: progress.kp >= building.cost_kp, concepts });
  }
  return out;
}

/** Sums the bonuses of whole buildings. */
export function cityBonuses(views: BuildingView[]): CityBonuses {
  const b = { ...NO_BONUSES };
  for (const v of views) {
    if (v.state !== "built" || !v.building.bonus) continue;
    const { kind, value } = v.building.bonus;
    if (kind === "max_hp") b.maxHp += value;
    else if (kind === "hint_charges") b.hintCharges += value;
    else if (kind === "xp_multiplier") b.xpMultiplier *= value;
    else if (kind === "kp_multiplier") b.kpMultiplier *= value;
  }
  return b;
}
