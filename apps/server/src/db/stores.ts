import type { OutboxEntry, OutboxStore, Statement } from "@moonbridge/xapi";
import type { GradeEntry, GradeJob, GradeStore } from "../grades.js";
import type { IdentityStore } from "../lti/identity.js";
import type { LoginStates, PendingLogin } from "../lti/launch.js";
import type { ProgressStore } from "../progress.js";
import type { ScoreStore } from "../scores.js";
import type { Sql } from "./sql.js";

// Postgres implementations of the gateway's stores (schema: migrations/). Every write
// is one statement, so the stores need no transactions and are safe across instances.

export class PgIdentityStore implements IdentityStore {
  constructor(private readonly sql: Sql) {}

  async playerFor(iss: string, sub: string): Promise<string> {
    const candidate = `player_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    // DO UPDATE (a no-op) instead of DO NOTHING so RETURNING yields the existing row too.
    const { rows } = await this.sql.query<{ player_id: string }>(
      `INSERT INTO lti_identities (iss, sub, player_id) VALUES ($1, $2, $3)
       ON CONFLICT (iss, sub) DO UPDATE SET iss = EXCLUDED.iss
       RETURNING player_id`,
      [iss, sub, candidate],
    );
    return rows[0]!.player_id;
  }
}

export class PgLoginStates implements LoginStates {
  constructor(private readonly sql: Sql, private readonly ttlMs = 5 * 60 * 1000, private readonly now: () => number = Date.now) {}

  async create(issuer: string, clientId: string) {
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    await this.sql.query("DELETE FROM lti_login_states WHERE expires_at <= $1", [new Date(this.now())]);
    await this.sql.query("INSERT INTO lti_login_states (state, nonce, issuer, client_id, expires_at) VALUES ($1, $2, $3, $4, $5)", [
      state,
      nonce,
      issuer,
      clientId,
      new Date(this.now() + this.ttlMs),
    ]);
    return { state, nonce };
  }

  async consume(state: string): Promise<PendingLogin | undefined> {
    const { rows } = await this.sql.query<{ nonce: string; issuer: string; client_id: string; expires_at: Date }>(
      "DELETE FROM lti_login_states WHERE state = $1 RETURNING nonce, issuer, client_id, expires_at",
      [state],
    );
    const r = rows[0];
    if (!r || r.expires_at.getTime() <= this.now()) return undefined;
    return { nonce: r.nonce, issuer: r.issuer, clientId: r.client_id, expiresAt: r.expires_at.getTime() };
  }
}

export class PgScoreStore implements ScoreStore {
  constructor(private readonly sql: Sql) {}

  async record(playerId: string, moduleId: string, scaled: number) {
    // The CTE reads the row as it was before this statement's upsert.
    const { rows } = await this.sql.query<{ best: number; prev: number | null }>(
      `WITH prev AS (SELECT best FROM module_scores WHERE player_id = $1 AND module_id = $2)
       INSERT INTO module_scores (player_id, module_id, best) VALUES ($1, $2, $3)
       ON CONFLICT (player_id, module_id) DO UPDATE
         SET best = GREATEST(module_scores.best, EXCLUDED.best), results = module_scores.results + 1, updated_at = now()
       RETURNING best, (SELECT best FROM prev) AS prev`,
      [playerId, moduleId, scaled],
    );
    const { best, prev } = rows[0]!;
    return { best, improved: prev === null || scaled > prev };
  }
}

interface GradeRow {
  job: GradeJob;
  attempts: number;
}

export class PgGradeStore implements GradeStore {
  constructor(private readonly sql: Sql) {}

  async offer(job: GradeJob, now: number): Promise<boolean> {
    // A new score resets the retry schedule; re-offering the pending score only refreshes
    // the job (a newer launch may carry fresher AGS endpoints). An accepted score is final.
    const { rows } = await this.sql.query<{ status: string }>(
      `INSERT INTO grade_outbox (player_id, module_id, context_key, job, score_given, status, next_attempt_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'pending', $6)
       ON CONFLICT (player_id, module_id, context_key) DO UPDATE SET
         job = EXCLUDED.job,
         score_given = EXCLUDED.score_given,
         status = 'pending',
         attempts = CASE WHEN grade_outbox.status = 'pending' AND grade_outbox.score_given = EXCLUDED.score_given THEN grade_outbox.attempts ELSE 0 END,
         next_attempt_at = CASE WHEN grade_outbox.status = 'pending' AND grade_outbox.score_given = EXCLUDED.score_given THEN grade_outbox.next_attempt_at ELSE EXCLUDED.next_attempt_at END,
         last_error = NULL,
         updated_at = now()
       WHERE NOT (grade_outbox.status = 'sent' AND grade_outbox.sent_score = EXCLUDED.score_given)
       RETURNING status`,
      [job.playerId, job.moduleId, job.contextKey, JSON.stringify(job), job.scoreGiven, new Date(now)],
    );
    return rows.length > 0;
  }

  async due(now: number, limit: number): Promise<GradeEntry[]> {
    const { rows } = await this.sql.query<GradeRow>(
      `SELECT job, attempts FROM grade_outbox WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT $2`,
      [new Date(now), limit],
    );
    return rows.map((r) => ({ ...r.job, attempts: r.attempts }));
  }

  async markSent(e: GradeEntry): Promise<void> {
    await this.sql.query(
      `UPDATE grade_outbox SET status = 'sent', sent_score = score_given, last_error = NULL, updated_at = now()
       WHERE player_id = $1 AND module_id = $2 AND context_key = $3 AND score_given = $4 AND status = 'pending'`,
      [e.playerId, e.moduleId, e.contextKey, e.scoreGiven],
    );
  }

  async reschedule(e: GradeEntry, nextAttemptAt: number, error: string): Promise<void> {
    await this.sql.query(
      `UPDATE grade_outbox SET attempts = attempts + 1, next_attempt_at = $5, last_error = $6, updated_at = now()
       WHERE player_id = $1 AND module_id = $2 AND context_key = $3 AND score_given = $4 AND status = 'pending'`,
      [e.playerId, e.moduleId, e.contextKey, e.scoreGiven, new Date(nextAttemptAt), error.slice(0, 2000)],
    );
  }

  async markFailed(e: GradeEntry, error: string): Promise<void> {
    await this.sql.query(
      `UPDATE grade_outbox SET status = 'failed', attempts = attempts + 1, last_error = $5, updated_at = now()
       WHERE player_id = $1 AND module_id = $2 AND context_key = $3 AND score_given = $4 AND status = 'pending'`,
      [e.playerId, e.moduleId, e.contextKey, e.scoreGiven, error.slice(0, 2000)],
    );
  }
}

interface OutboxRow {
  statement: Statement;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
}

/** The server side of the xAPI outbox: statements accepted from clients survive restarts and LRS outages. */
export class PgOutboxStore implements OutboxStore {
  constructor(private readonly sql: Sql) {}

  async enqueue(statements: Statement[], now: number): Promise<number> {
    if (statements.length === 0) return 0;
    // One statement per call: ids already queued, sent or dead are skipped by the primary key.
    const { rows } = await this.sql.query<{ id: string }>(
      `INSERT INTO xapi_outbox (id, statement, status, queued_at, next_attempt_at)
       SELECT (s->>'id')::uuid, s, 'pending', $2, $2 FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(s, n) ORDER BY n
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [JSON.stringify(statements), new Date(now)],
    );
    return rows.length;
  }

  async due(now: number, limit: number): Promise<OutboxEntry[]> {
    const { rows } = await this.sql.query<OutboxRow>(
      `SELECT statement, attempts, next_attempt_at, last_error FROM xapi_outbox
       WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY queued_at, seq LIMIT $2`,
      [new Date(now), limit],
    );
    return rows.map((r) => ({
      statement: r.statement,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at.getTime(),
      ...(r.last_error ? { lastError: r.last_error } : {}),
    }));
  }

  async markSent(ids: string[]): Promise<void> {
    if (ids.length) await this.sql.query("UPDATE xapi_outbox SET status = 'sent', statement = NULL, last_error = NULL WHERE id = ANY($1::uuid[]) AND status = 'pending'", [ids]);
  }

  async reschedule(ids: string[], nextAttemptAt: number, error: string): Promise<void> {
    if (ids.length) {
      await this.sql.query("UPDATE xapi_outbox SET attempts = attempts + 1, next_attempt_at = $2, last_error = $3 WHERE id = ANY($1::uuid[]) AND status = 'pending'", [
        ids,
        new Date(nextAttemptAt),
        error.slice(0, 2000),
      ]);
    }
  }

  async markDead(ids: string[], error: string): Promise<void> {
    if (ids.length) await this.sql.query("UPDATE xapi_outbox SET status = 'dead', last_error = $2 WHERE id = ANY($1::uuid[]) AND status = 'pending'", [ids, error.slice(0, 2000)]);
  }

  async pendingCount(): Promise<number> {
    const { rows } = await this.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM xapi_outbox WHERE status = 'pending'");
    return rows[0]!.n;
  }
}

export class PgProgressStore implements ProgressStore {
  constructor(private readonly sql: Sql) {}

  async get(playerId: string) {
    const { rows } = await this.sql.query<{ snapshot: unknown; saved_at: Date }>("SELECT snapshot, saved_at FROM player_progress WHERE player_id = $1", [playerId]);
    const r = rows[0];
    return r && { snapshot: r.snapshot, savedAt: r.saved_at };
  }

  async put(playerId: string, snapshot: unknown, savedAt: Date) {
    const { rows } = await this.sql.query<{ saved_at: Date }>(
      `INSERT INTO player_progress (player_id, snapshot, saved_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (player_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, saved_at = EXCLUDED.saved_at, updated_at = now()
       WHERE player_progress.saved_at < EXCLUDED.saved_at
       RETURNING saved_at`,
      [playerId, JSON.stringify(snapshot), savedAt],
    );
    if (rows[0]) return { accepted: true, savedAt: rows[0].saved_at };
    const current = await this.get(playerId);
    return { accepted: false, savedAt: current?.savedAt ?? savedAt };
  }
}
