import type { ContentBundle, Progression, Reward } from "@knight/content";

/**
 * Used only when the content has no world/progression.json, so that older bundles
 * still run. Balancing belongs in that file, not here.
 */
export const DEFAULT_PROGRESSION: Progression = {
  schema_version: "1.0",
  knight: { base_hp: 30, hints_per_battle: 1 },
  levels: { xp_to_reach: [0, 100, 250, 450, 700, 1000], hp_per_level: 3 },
  rewards: {
    answer_correct: { xp: 5 },
    answer_typo: { xp: 2 },
    encounter_won: { xp: 20, kp: 10 },
    boss_passed: { xp: 100, kp: 40 },
    patrol_completed: { xp: 50, kp: 25 },
    building_repaired: { xp: 20, kp: 15 },
  },
  patrol: { size: 12, task_cooldown_days: 3, enemies: [] },
  repair: { threshold: 0.8, task_count: 6 },
};

export function rulesOf(bundle: ContentBundle): Progression {
  return bundle.progression ?? DEFAULT_PROGRESSION;
}

export interface LevelView {
  level: number;
  /** Total XP at which the current level began. */
  levelStartXp: number;
  /** Total XP for the next level; undefined at the top of the curve. */
  nextLevelXp?: number;
}

/** The knight's level for a total XP: the last threshold reached, 1-based. */
export function levelOf(xp: number, rules: Progression): LevelView {
  const curve = rules.levels.xp_to_reach;
  let i = 0;
  while (i + 1 < curve.length && xp >= curve[i + 1]!) i++;
  return { level: i + 1, levelStartXp: curve[i]!, ...(i + 1 < curve.length ? { nextLevelXp: curve[i + 1]! } : {}) };
}

/** Bonuses from the buildings standing whole in the city. A damaged building gives none. */
export interface CityBonuses {
  maxHp: number;
  xpMultiplier: number;
  kpMultiplier: number;
  hintCharges: number;
}

export const NO_BONUSES: CityBonuses = { maxHp: 0, xpMultiplier: 1, kpMultiplier: 1, hintCharges: 0 };

/** Applies multipliers to a reward; rounds to whole points. */
export function scaleReward(r: Reward, b: CityBonuses, times = 1): { xp: number; kp: number } {
  return { xp: Math.round((r.xp ?? 0) * times * b.xpMultiplier), kp: Math.round((r.kp ?? 0) * times * b.kpMultiplier) };
}

/** The player's local calendar day, YYYY-MM-DD: the unit of "daily". */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
