/** Best score per (player, module). AGS keeps the latest score it receives, so we only ever send the best one. */
export interface ScoreStore {
  /** Records a result and returns the best so far (which may be the new one). */
  record(playerId: string, moduleId: string, scaled: number): Promise<{ best: number; improved: boolean }>;
}

export class MemoryScoreStore implements ScoreStore {
  private readonly best = new Map<string, number>();

  async record(playerId: string, moduleId: string, scaled: number) {
    const key = `${playerId}\u0000${moduleId}`;
    const prev = this.best.get(key);
    const improved = prev === undefined || scaled > prev;
    if (improved) this.best.set(key, scaled);
    return { best: improved ? scaled : prev!, improved };
  }
}
