import type { SendOutcome, StatementSink } from "./lrs-client.js";
import type { Statement } from "./types.js";

export interface OutboxEntry {
  statement: Statement;
  attempts: number;
  /** Epoch ms; the entry is not sent before this. */
  nextAttemptAt: number;
  lastError?: string;
}

/**
 * Storage behind the outbox. In-memory here; IndexedDB (Dexie) in the browser
 * and a Postgres table on the server implement the same interface.
 */
export interface OutboxStore {
  /** Adds statements; an id already queued, sent or dead is ignored (idempotent enqueue). */
  enqueue(statements: Statement[], now: number): Promise<number>;
  /** Up to `limit` entries due at `now`, oldest first. */
  due(now: number, limit: number): Promise<OutboxEntry[]>;
  markSent(ids: string[]): Promise<void>;
  reschedule(ids: string[], nextAttemptAt: number, error: string): Promise<void>;
  /** Moves entries to a dead-letter list for manual inspection. */
  markDead(ids: string[], error: string): Promise<void>;
  pendingCount(): Promise<number>;
}

export class MemoryOutboxStore implements OutboxStore {
  private readonly pending = new Map<string, OutboxEntry>();
  private readonly sent = new Set<string>();
  readonly dead = new Map<string, OutboxEntry>();

  async enqueue(statements: Statement[], now: number): Promise<number> {
    let added = 0;
    for (const statement of statements) {
      const id = statement.id;
      if (this.pending.has(id) || this.sent.has(id) || this.dead.has(id)) continue;
      this.pending.set(id, { statement, attempts: 0, nextAttemptAt: now });
      added++;
    }
    return added;
  }

  async due(now: number, limit: number): Promise<OutboxEntry[]> {
    return [...this.pending.values()].filter((e) => e.nextAttemptAt <= now).slice(0, limit);
  }

  async markSent(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.pending.delete(id);
      this.sent.add(id);
    }
  }

  async reschedule(ids: string[], nextAttemptAt: number, error: string): Promise<void> {
    for (const id of ids) {
      const e = this.pending.get(id);
      if (e) Object.assign(e, { attempts: e.attempts + 1, nextAttemptAt, lastError: error });
    }
  }

  async markDead(ids: string[], error: string): Promise<void> {
    for (const id of ids) {
      const e = this.pending.get(id);
      if (!e) continue;
      this.pending.delete(id);
      this.dead.set(id, { ...e, lastError: error });
    }
  }

  async pendingCount(): Promise<number> {
    return this.pending.size;
  }
}

export interface FlushOptions {
  batchSize?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** After this many failed attempts an entry is dead-lettered instead of retried. */
  maxAttempts?: number;
  now?: () => number;
  random?: () => number;
}

export interface FlushReport {
  sent: number;
  retried: number;
  dead: number;
}

/**
 * Delivers queued statements to a sink with exponential backoff and jitter.
 * Delivery is at-least-once; the LRS deduplicates by statement id.
 */
export class Outbox {
  private readonly o: Required<FlushOptions>;
  private flushing: Promise<FlushReport> | null = null;

  constructor(private readonly store: OutboxStore, private readonly sink: StatementSink, options: FlushOptions = {}) {
    this.o = {
      batchSize: 50,
      baseDelayMs: 2000,
      maxDelayMs: 10 * 60 * 1000,
      maxAttempts: 20,
      now: Date.now,
      random: Math.random,
      ...options,
    };
  }

  enqueue(statements: Statement[]): Promise<number> {
    return this.store.enqueue(statements, this.o.now());
  }

  /** Sends everything that is due. Concurrent calls share one flush. */
  flush(): Promise<FlushReport> {
    this.flushing ??= this.run().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async run(): Promise<FlushReport> {
    const report: FlushReport = { sent: 0, retried: 0, dead: 0 };
    for (;;) {
      const batch = await this.store.due(this.o.now(), this.o.batchSize);
      if (batch.length === 0) return report;
      const outcome = await this.sink.send(batch.map((e) => e.statement));
      const ids = batch.map((e) => e.statement.id);
      if (outcome.kind === "sent") {
        await this.store.markSent(ids);
        report.sent += ids.length;
        continue;
      }
      if (outcome.kind === "rejected" && batch.length > 1) {
        // One bad statement must not block the rest: retry the batch one by one.
        for (const entry of batch) await this.sendSingle(entry, report);
        continue;
      }
      if (outcome.kind === "rejected") {
        await this.store.markDead(ids, `HTTP ${outcome.status}: ${outcome.reason}`);
        report.dead += ids.length;
        continue;
      }
      await this.retryLater(batch, outcome, report);
      return report;
    }
  }

  private async sendSingle(entry: OutboxEntry, report: FlushReport): Promise<void> {
    const outcome: SendOutcome = await this.sink.send([entry.statement]);
    const ids = [entry.statement.id];
    if (outcome.kind === "sent") {
      await this.store.markSent(ids);
      report.sent++;
    } else if (outcome.kind === "rejected") {
      await this.store.markDead(ids, `HTTP ${outcome.status}: ${outcome.reason}`);
      report.dead++;
    } else {
      await this.retryLater([entry], outcome, report);
    }
  }

  private async retryLater(batch: OutboxEntry[], outcome: Extract<SendOutcome, { kind: "retry" }>, report: FlushReport) {
    const exhausted = batch.filter((e) => e.attempts + 1 >= this.o.maxAttempts).map((e) => e.statement.id);
    const retry = batch.filter((e) => e.attempts + 1 < this.o.maxAttempts);
    if (exhausted.length) {
      await this.store.markDead(exhausted, `gave up after ${this.o.maxAttempts} attempts: ${outcome.reason}`);
      report.dead += exhausted.length;
    }
    if (retry.length) {
      const attempts = Math.min(...retry.map((e) => e.attempts));
      const backoff = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** attempts);
      const delay = Math.max(outcome.retryAfterMs ?? 0, backoff * (0.5 + this.o.random() / 2));
      await this.store.reschedule(retry.map((e) => e.statement.id), this.o.now() + delay, outcome.reason);
      report.retried += retry.length;
    }
  }
}
