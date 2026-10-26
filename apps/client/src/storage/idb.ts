import type { Attempt, AttemptJournal } from "@knight/learning";
import type { OutboxEntry, OutboxStore, Statement } from "@knight/xapi";

// IndexedDB storage for one player: settings and state (kv), the attempt journal
// and the xAPI outbox. One database per player, so two people sharing a browser
// (or one LMS user and one guest) never mix their history.

const VERSION = 1;

export function openPlayerDb(playerId: string, factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(`knight-of-words:${playerId}`, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("kv");
      db.createObjectStore("attempts", { keyPath: "attempt_id" });
      const outbox = db.createObjectStore("outbox", { keyPath: "id" });
      outbox.createIndex("status", "status");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Small key-value store for JSON state: progress, FSRS cards, the cached content bundle. */
export interface KeyValue {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export class IdbKeyValue implements KeyValue {
  constructor(private readonly db: IDBDatabase) {}

  async get<T>(key: string): Promise<T | undefined> {
    return (await result(this.db.transaction("kv").objectStore("kv").get(key))) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    await done(tx);
  }
}

export class MemoryKeyValue implements KeyValue {
  private readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

export class IdbJournal implements AttemptJournal {
  constructor(private readonly db: IDBDatabase) {}

  async append(attempt: Attempt): Promise<void> {
    const tx = this.db.transaction("attempts", "readwrite");
    tx.objectStore("attempts").put(attempt);
    await done(tx);
  }

  async all(): Promise<Attempt[]> {
    const list = await result(this.db.transaction("attempts").objectStore("attempts").getAll());
    return (list as Attempt[]).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}

type OutboxRow =
  | ({ id: string; status: "pending"; queuedAt: number } & OutboxEntry)
  | ({ id: string; status: "dead"; queuedAt: number } & OutboxEntry)
  // Sent rows drop the payload and keep only the id, for idempotent enqueue.
  | { id: string; status: "sent" };

/** The browser side of the xAPI outbox: statements survive reloads and offline play until the server accepts them. */
export class IdbOutboxStore implements OutboxStore {
  constructor(private readonly db: IDBDatabase) {}

  async enqueue(statements: Statement[], now: number): Promise<number> {
    const tx = this.db.transaction("outbox", "readwrite");
    const store = tx.objectStore("outbox");
    let added = 0;
    for (const statement of statements) {
      const existing = await result(store.getKey(statement.id));
      if (existing !== undefined) continue;
      store.add({ id: statement.id, status: "pending", queuedAt: now, statement, attempts: 0, nextAttemptAt: now } satisfies OutboxRow);
      added++;
    }
    await done(tx);
    return added;
  }

  async due(now: number, limit: number): Promise<OutboxEntry[]> {
    const rows = (await result(this.db.transaction("outbox").objectStore("outbox").index("status").getAll("pending"))) as OutboxRow[];
    return rows
      .filter((r): r is Extract<OutboxRow, { status: "pending" }> => r.status === "pending" && r.nextAttemptAt <= now)
      .sort((a, b) => a.queuedAt - b.queuedAt || (a.statement.timestamp ?? "").localeCompare(b.statement.timestamp ?? ""))
      .slice(0, limit)
      .map(({ statement, attempts, nextAttemptAt, lastError }) => ({ statement, attempts, nextAttemptAt, ...(lastError ? { lastError } : {}) }));
  }

  markSent(ids: string[]): Promise<void> {
    return this.update(ids, (row) => ({ id: row.id, status: "sent" }));
  }

  reschedule(ids: string[], nextAttemptAt: number, error: string): Promise<void> {
    return this.update(ids, (row) => (row.status === "pending" ? { ...row, attempts: row.attempts + 1, nextAttemptAt, lastError: error } : row));
  }

  markDead(ids: string[], error: string): Promise<void> {
    return this.update(ids, (row) => (row.status === "pending" ? { ...row, status: "dead", lastError: error } : row));
  }

  async pendingCount(): Promise<number> {
    return result(this.db.transaction("outbox").objectStore("outbox").index("status").count("pending"));
  }

  private async update(ids: string[], change: (row: OutboxRow) => OutboxRow): Promise<void> {
    const tx = this.db.transaction("outbox", "readwrite");
    const store = tx.objectStore("outbox");
    for (const id of ids) {
      const row = (await result(store.get(id))) as OutboxRow | undefined;
      if (row) store.put(change(row));
    }
    await done(tx);
  }
}
