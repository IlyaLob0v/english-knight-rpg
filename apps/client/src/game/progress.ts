import type { ContentBundle, Enemy, Module, Track, TrackStep } from "@knight/content";

/** Victories needed before the boss when a track step does not say. */
export const DEFAULT_WINS_BEFORE_BOSS = 2;

/**
 * Progress is keyed by module_id, not by position in the track: reordering the
 * track in content keeps everything the player has already done.
 */
export interface ModuleProgress {
  wins: number;
  bossPassed: boolean;
  /** Best boss score so far, 0..1. */
  bestScore: number;
  bossAttempts: number;
}

/** A building that stands in the city. Keyed by building_id, so reassigning it in the track keeps it built. */
export interface BuildingProgress {
  builtAt: string;
  /** Last known state; the live state comes from FSRS. A change from true to false is a repair. */
  damaged: boolean;
  repairs: number;
}

export interface PlayerProgress {
  version: 2;
  modules: Record<string, ModuleProgress>;
  /** story_ids already shown, so intros play once. */
  seenStories: string[];
  xp: number;
  kp: number;
  buildings: Record<string, BuildingProgress>;
  /** Local days (YYYY-MM-DD) with a completed patrol, in order. */
  patrolDays: string[];
}

export function emptyProgress(): PlayerProgress {
  return { version: 2, modules: {}, seenStories: [], xp: 0, kp: 0, buildings: {}, patrolDays: [] };
}

/** Brings saved progress of any earlier version up to date; nothing the player did is lost. */
export function migrateProgress(saved: unknown): PlayerProgress {
  const p = (saved ?? {}) as Partial<PlayerProgress> & { version?: number };
  return {
    ...emptyProgress(),
    ...p,
    version: 2,
    modules: p.modules ?? {},
    seenStories: p.seenStories ?? [],
    buildings: p.buildings ?? {},
    patrolDays: p.patrolDays ?? [],
  };
}

export function moduleProgress(p: PlayerProgress, moduleId: string): ModuleProgress {
  return p.modules[moduleId] ?? { wins: 0, bossPassed: false, bestScore: 0, bossAttempts: 0 };
}

export type StepStatus = "locked" | "open" | "boss_ready" | "cleared";

export interface StepView {
  chapterId: string;
  /** Position in the whole track, 0-based. */
  index: number;
  step: TrackStep;
  module: Module;
  status: StepStatus;
  wins: number;
  winsNeeded: number;
  encounterEnemies: Enemy[];
  /** The step's boss; a step without one ends with a trial against its toughest ordinary enemy. */
  boss: Enemy;
}

/** Fallback opponent for a step with neither a boss nor encounters. */
const TRIAL: Enemy = { enemy_id: "trial", name: { en: "The Trial", ru: "Испытание" }, sprite: "", role: "boss", hp: 100, damage: 10 };

/**
 * The map as the player sees it: steps unlock one after another in track order,
 * and a step's boss unlocks after enough ordinary victories.
 */
export function trackView(bundle: ContentBundle, track: Track, progress: PlayerProgress): StepView[] {
  const modules = new Map(bundle.modules.map((m) => [m.module_id, m]));
  const enemies = new Map(bundle.enemies.map((e) => [e.enemy_id, e]));
  const out: StepView[] = [];
  let previousCleared = true;
  for (const chapter of track.chapters) {
    for (const step of chapter.steps) {
      const module = modules.get(step.module_id);
      if (!module) throw new Error(`track ${track.track_id} refers to unknown module ${step.module_id}`);
      const mp = moduleProgress(progress, step.module_id);
      const encounterEnemies = (step.encounters?.enemies ?? []).map((id) => enemies.get(id)).filter((e): e is Enemy => !!e);
      const winsNeeded = encounterEnemies.length ? (step.encounters?.wins_before_boss ?? DEFAULT_WINS_BEFORE_BOSS) : 0;
      const status: StepStatus = mp.bossPassed
        ? "cleared"
        : !previousCleared
          ? "locked"
          : mp.wins >= winsNeeded
            ? "boss_ready"
            : "open";
      const toughest = [...encounterEnemies].sort((a, b) => b.hp - a.hp)[0];
      const boss = (step.boss ? enemies.get(step.boss) : undefined) ?? (toughest ? { ...toughest, role: "boss" as const } : TRIAL);
      out.push({ chapterId: chapter.chapter_id, index: out.length, step, module, status, wins: mp.wins, winsNeeded, encounterEnemies, boss });
      previousCleared = status === "cleared";
    }
  }
  return out;
}

export function recordEncounterWin(p: PlayerProgress, moduleId: string): PlayerProgress {
  const mp = moduleProgress(p, moduleId);
  return { ...p, modules: { ...p.modules, [moduleId]: { ...mp, wins: mp.wins + 1 } } };
}

export function recordBossResult(p: PlayerProgress, moduleId: string, r: { passed: boolean; scaled: number }): PlayerProgress {
  const mp = moduleProgress(p, moduleId);
  return {
    ...p,
    modules: {
      ...p.modules,
      [moduleId]: { ...mp, bossPassed: mp.bossPassed || r.passed, bestScore: Math.max(mp.bestScore, r.scaled), bossAttempts: mp.bossAttempts + 1 },
    },
  };
}

export function addCurrency(p: PlayerProgress, r: { xp: number; kp: number }): PlayerProgress {
  return { ...p, xp: p.xp + r.xp, kp: Math.max(0, p.kp + r.kp) };
}

export function markStorySeen(p: PlayerProgress, storyId: string): PlayerProgress {
  return p.seenStories.includes(storyId) ? p : { ...p, seenStories: [...p.seenStories, storyId] };
}
