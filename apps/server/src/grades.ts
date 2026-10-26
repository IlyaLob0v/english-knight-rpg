import { AgsClient, AgsError } from "./lti/ags.js";
import type { AgsEndpoint } from "./lti/claims.js";
import type { PlatformRegistry } from "./lti/platforms.js";

/** A module grade for one LMS gradebook, with everything needed to send it after the session is gone. */
export interface GradeJob {
  playerId: string;
  moduleId: string;
  /** Which gradebook: one LMS context (course) of one platform registration. */
  contextKey: string;
  /** Column title when the line item has to be created. */
  label: string;
  /** 0–100, the player's best result for the module. */
  scoreGiven: number;
  iss: string;
  clientId: string;
  /** The LMS user id. */
  sub: string;
  ags: AgsEndpoint;
  /** custom.module_id of the launch, when the LMS link is bound to one module. */
  launchModuleId?: string;
}

export interface GradeEntry extends GradeJob {
  attempts: number;
}

/**
 * The AGS retry queue: a grade is stored before it is sent and stays until the LMS
 * accepts it, so an LMS outage delays a grade but never loses it.
 */
export interface GradeStore {
  /**
   * Queues the grade, replacing a pending one for the same gradebook cell. Returns
   * false when exactly this score was already accepted by the LMS.
   */
  offer(job: GradeJob, now: number): Promise<boolean>;
  due(now: number, limit: number): Promise<GradeEntry[]>;
  /** Marks the grade sent, unless a newer score was queued meanwhile. */
  markSent(entry: GradeEntry): Promise<void>;
  reschedule(entry: GradeEntry, nextAttemptAt: number, error: string): Promise<void>;
  markFailed(entry: GradeEntry, error: string): Promise<void>;
}

export function contextKey(iss: string, clientId: string, contextId?: string, ags?: AgsEndpoint): string {
  // A space cannot occur in an issuer URL, so the parts never run into each other.
  return [iss, clientId, contextId ?? ags?.lineitems ?? ags?.lineitem ?? ""].join(" ");
}

const cellKey = (j: { playerId: string; moduleId: string; contextKey: string }) => `${j.playerId}\u0000${j.moduleId}\u0000${j.contextKey}`;

export class MemoryGradeStore implements GradeStore {
  readonly rows = new Map<string, { job: GradeJob; status: "pending" | "sent" | "failed"; sentScore?: number; attempts: number; nextAttemptAt: number; lastError?: string }>();

  async offer(job: GradeJob, now: number): Promise<boolean> {
    const row = this.rows.get(cellKey(job));
    if (row?.sentScore === job.scoreGiven && row.status === "sent") return false;
    if (row?.status === "pending" && row.job.scoreGiven === job.scoreGiven) {
      row.job = job;
      return true;
    }
    this.rows.set(cellKey(job), { job, status: "pending", ...(row?.sentScore !== undefined ? { sentScore: row.sentScore } : {}), attempts: 0, nextAttemptAt: now });
    return true;
  }

  async due(now: number, limit: number): Promise<GradeEntry[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === "pending" && r.nextAttemptAt <= now)
      .slice(0, limit)
      .map((r) => ({ ...r.job, attempts: r.attempts }));
  }

  async markSent(entry: GradeEntry): Promise<void> {
    const row = this.rows.get(cellKey(entry));
    if (row && row.job.scoreGiven === entry.scoreGiven) Object.assign(row, { status: "sent", sentScore: entry.scoreGiven });
  }

  async reschedule(entry: GradeEntry, nextAttemptAt: number, error: string): Promise<void> {
    const row = this.rows.get(cellKey(entry));
    if (row && row.job.scoreGiven === entry.scoreGiven) Object.assign(row, { attempts: row.attempts + 1, nextAttemptAt, lastError: error });
  }

  async markFailed(entry: GradeEntry, error: string): Promise<void> {
    const row = this.rows.get(cellKey(entry));
    if (row && row.job.scoreGiven === entry.scoreGiven) Object.assign(row, { status: "failed", lastError: error });
  }
}

export interface GradeSyncOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** After this many failed attempts the grade is parked as failed for an admin to look at. */
  maxAttempts?: number;
  now?: () => number;
}

export type GradeOutcome = "sent" | "queued" | "not_improved";

/** Sends queued grades through AGS: right away for a fresh result, then on a timer with backoff. */
export class GradeSync {
  private readonly o: Required<GradeSyncOptions>;
  private flushing: Promise<{ sent: number; retried: number; failed: number }> | null = null;
  /** Cells being delivered right now: a timer flush must not send the same grade twice at once. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: GradeStore,
    private readonly platforms: PlatformRegistry,
    private readonly ags: AgsClient,
    options: GradeSyncOptions = {},
    private readonly log: (error: unknown, message: string) => void = () => undefined,
  ) {
    // 15 attempts with these delays span about a day of LMS downtime.
    this.o = { baseDelayMs: 5000, maxDelayMs: 2 * 3600 * 1000, maxAttempts: 15, now: Date.now, ...options };
  }

  /** Queues a grade and tries to deliver it at once. "queued" means it is retried in the background. */
  async submit(job: GradeJob): Promise<GradeOutcome> {
    if (!(await this.store.offer(job, this.o.now()))) return "not_improved";
    return (await this.deliver({ ...job, attempts: 0 })) ? "sent" : "queued";
  }

  /** Delivers everything due. Concurrent calls share one run. */
  flush(): Promise<{ sent: number; retried: number; failed: number }> {
    this.flushing ??= this.run().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async run() {
    const report = { sent: 0, retried: 0, failed: 0 };
    for (const entry of await this.store.due(this.o.now(), 100)) {
      if (this.inFlight.has(cellKey(entry))) continue;
      const ok = await this.deliver(entry);
      if (ok) report.sent++;
      else if (entry.attempts + 1 >= this.o.maxAttempts) report.failed++;
      else report.retried++;
    }
    return report;
  }

  private async deliver(entry: GradeEntry): Promise<boolean> {
    const key = cellKey(entry);
    this.inFlight.add(key);
    try {
      const platform = this.platforms.find(entry.iss, entry.clientId);
      if (!platform) throw new AgsError("platform no longer registered");
      const lineItem = await this.ags.lineItemFor(
        platform,
        entry.ags,
        { moduleId: entry.moduleId, label: entry.label, scoreMaximum: 100 },
        entry.launchModuleId,
      );
      await this.ags.submitScore(platform, lineItem, {
        userId: entry.sub,
        scoreGiven: entry.scoreGiven,
        scoreMaximum: 100,
        activityProgress: "Completed",
        gradingProgress: "FullyGraded",
        timestamp: new Date(this.o.now()).toISOString(),
      });
      await this.store.markSent(entry);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(e, `AGS: grade for ${entry.moduleId} not delivered (attempt ${entry.attempts + 1})`);
      if (entry.attempts + 1 >= this.o.maxAttempts) {
        await this.store.markFailed(entry, message);
      } else {
        const delay = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** entry.attempts);
        await this.store.reschedule(entry, this.o.now() + delay, message);
      }
      return false;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
