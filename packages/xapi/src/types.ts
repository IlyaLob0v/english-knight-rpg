// Subset of the xAPI 1.0.3 data model used by the game.
// Spec: https://github.com/adlnet/xAPI-Spec/blob/master/xAPI-Data.md

export type LanguageMap = Record<string, string>;

export interface Account {
  homePage: string;
  name: string;
}

export interface Agent {
  objectType?: "Agent";
  name?: string;
  account: Account;
}

export interface Verb {
  id: string;
  display?: LanguageMap;
}

export interface ActivityDefinition {
  type?: string;
  name?: LanguageMap;
  description?: LanguageMap;
  interactionType?: "true-false" | "choice" | "fill-in" | "long-fill-in" | "matching" | "performance" | "sequencing" | "likert" | "numeric" | "other";
  correctResponsesPattern?: string[];
  choices?: { id: string; description: LanguageMap }[];
  extensions?: Record<string, unknown>;
}

export interface Activity {
  objectType?: "Activity";
  id: string;
  definition?: ActivityDefinition;
}

export interface Result {
  success?: boolean;
  completion?: boolean;
  response?: string;
  duration?: string;
  score?: { scaled?: number; raw?: number; min?: number; max?: number };
  extensions?: Record<string, unknown>;
}

export interface Context {
  registration?: string;
  contextActivities?: {
    parent?: Activity[];
    grouping?: Activity[];
    category?: Activity[];
    other?: Activity[];
  };
  platform?: string;
  language?: string;
  extensions?: Record<string, unknown>;
}

export interface Statement {
  id: string;
  actor: Agent;
  verb: Verb;
  object: Activity;
  result?: Result;
  context?: Context;
  timestamp: string;
}
