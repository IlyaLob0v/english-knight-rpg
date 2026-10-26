// Types mirror the JSON Schemas in ../schemas. The schemas are the source of truth;
// keep these in sync when a schema changes (and bump schema_version).

export type CefrLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
export type TaskType = "choice" | "gap_fill" | "transform" | "order_words";

export interface Localized {
  en: string;
  ru: string;
}

export interface Concept {
  concept_id: string;
  label: string;
  explanation_ru?: string;
}

export interface Module {
  schema_version: "1.0";
  module_id: string;
  version: number;
  cefr_level: CefrLevel;
  title: Localized;
  description?: Localized;
  skill: "grammar" | "vocabulary" | "reading" | "listening";
  grammar_topic?: string;
  vocabulary_set?: string;
  prerequisites: string[];
  concepts: Concept[];
  mastery: { boss_task_count: number; pass_score: number };
  tasks: string[];
}

export interface KnownError {
  match: string[];
  error_type: string;
  feedback?: string;
}

export interface Task {
  task_id: string;
  concept_id: string;
  type: TaskType;
  difficulty: number;
  presentation: {
    speaker?: string;
    prompt: string;
    instruction_ru?: string;
    hint?: string;
    source?: string;
    options?: { id: string; text: string }[];
    tokens?: string[];
  };
  answer: {
    accepted: string[];
    case_sensitive?: boolean;
    known_errors?: KnownError[];
  };
  combat?: { damage?: number; time_limit_s?: number };
  tags?: string[];
}

export interface TaskSet {
  schema_version: "1.0";
  module_id: string;
  tasks: Task[];
}

export interface TrackStep {
  module_id: string;
  quest_id: string;
  unlocks_building: string;
  boss?: string;
  /** story_id shown before the step's first battle. */
  intro?: string;
  /** story_id shown after the boss is defeated. */
  outro?: string;
  /** Ordinary battles; the boss unlocks after `wins_before_boss` (default 2) victories. */
  encounters?: { enemies: string[]; wins_before_boss?: number };
}

export interface Track {
  schema_version: "1.0";
  track_id: string;
  title: Localized;
  chapters: { chapter_id: string; story_intro?: string; steps: TrackStep[] }[];
}

export interface Building {
  building_id: string;
  name: Localized;
  sprite: string;
  cost_kp: number;
  bonus?: { kind: "xp_multiplier" | "hint_charges" | "max_hp" | "kp_multiplier"; value: number };
}

export interface Enemy {
  enemy_id: string;
  name: Localized;
  sprite: string;
  role: "minion" | "elite" | "boss";
  hp: number;
  damage: number;
}

export interface StoryLine {
  speaker?: Localized;
  text: Localized;
}

export interface Story {
  schema_version: "1.0";
  story_id: string;
  lines: StoryLine[];
}

export interface Reward {
  xp?: number;
  kp?: number;
}

/** Economy and the daily loop: XP, levels, KP, patrol and repair. One file, world/progression.json. */
export interface Progression {
  schema_version: "1.0";
  knight: { base_hp: number; hints_per_battle: number };
  /** xp_to_reach[i] is the total XP needed for level i + 1. */
  levels: { xp_to_reach: number[]; hp_per_level: number };
  rewards: {
    /** Per correct answer, multiplied by the task difficulty. */
    answer_correct: Reward;
    answer_typo?: Reward;
    encounter_won: Reward;
    /** Only the first time a module's boss falls. */
    boss_passed: Reward;
    /** Once per day. */
    patrol_completed: Reward;
    building_repaired: Reward;
  };
  patrol: { size: number; task_cooldown_days: number; enemies: string[] };
  /** A building needs repair when a studied concept of its module drops below `threshold` recall probability. */
  repair: { threshold: number; task_count: number };
}

export interface ErrorType {
  id: string;
  label: Localized;
  deprecated?: boolean;
}

export interface ErrorTaxonomy {
  schema_version: "1.0";
  version: number;
  error_types: ErrorType[];
}

/** A parsed content file together with where it came from, for error messages. */
export interface SourceFile<T = unknown> {
  path: string;
  data: T;
}

/** Raw content as read from the /content directory, before validation. */
export interface ContentSource {
  taxonomy: SourceFile[];
  modules: SourceFile[];
  taskSets: SourceFile[];
  tracks: SourceFile[];
  buildings: SourceFile[];
  enemies: SourceFile[];
  /** Optional so that older uploads without stories still validate. */
  stories?: SourceFile[];
  /** At most one file; the game falls back to built-in defaults without it. */
  progression?: SourceFile[];
}

/** Validated content, flattened and indexed: this is what the game and the engine consume. */
export interface ContentBundle {
  bundle_schema_version: "1.0";
  /** Content hash: changes whenever any content changes, stable otherwise. */
  content_hash: string;
  built_at: string;
  taxonomy: ErrorTaxonomy;
  modules: Module[];
  tasks: Record<string, Task & { module_id: string }>;
  tracks: Track[];
  buildings: Building[];
  enemies: Enemy[];
  stories: Story[];
  progression?: Progression;
}
