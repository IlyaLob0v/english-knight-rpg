/**
 * The latest backup of a player's game state. The browser stays the source of truth
 * (the game works offline); the backup lets an LMS player open the game on another
 * device and find their city. The newest save wins, by the client's saved_at.
 */
export interface ProgressStore {
  get(playerId: string): Promise<{ snapshot: unknown; savedAt: Date } | undefined>;
  /** Stores the snapshot unless a newer one is already stored; returns what is stored now. */
  put(playerId: string, snapshot: unknown, savedAt: Date): Promise<{ accepted: boolean; savedAt: Date }>;
}

export class MemoryProgressStore implements ProgressStore {
  private readonly data = new Map<string, { snapshot: unknown; savedAt: Date }>();

  async get(playerId: string) {
    const v = this.data.get(playerId);
    return v && { snapshot: structuredClone(v.snapshot), savedAt: v.savedAt };
  }

  async put(playerId: string, snapshot: unknown, savedAt: Date) {
    const prev = this.data.get(playerId);
    if (prev && prev.savedAt >= savedAt) return { accepted: false, savedAt: prev.savedAt };
    this.data.set(playerId, { snapshot: structuredClone(snapshot), savedAt });
    return { accepted: true, savedAt };
  }
}
