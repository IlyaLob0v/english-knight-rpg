/**
 * Links LMS identities to game players: (iss, sub) → player_id. xAPI always uses
 * the player_id, so a player's history does not split when they start playing
 * through the LMS. Postgres-backed in week 5; same interface.
 */
export interface IdentityStore {
  playerFor(iss: string, sub: string): Promise<string>;
}

export class MemoryIdentityStore implements IdentityStore {
  private readonly links = new Map<string, string>();

  async playerFor(iss: string, sub: string): Promise<string> {
    const key = `${iss}\u0000${sub}`;
    let id = this.links.get(key);
    if (!id) this.links.set(key, (id = `player_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`));
    return id;
  }
}
