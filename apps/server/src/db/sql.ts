import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

/**
 * The slice of a Postgres client the stores use. node-postgres implements it in
 * production; PGlite (Postgres compiled to WASM) implements it in tests, so the
 * stores are tested against real Postgres SQL without a database server.
 */
export interface Sql {
  /** One statement with $1… parameters. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** A script of several statements, no parameters. */
  exec(text: string): Promise<unknown>;
}

export interface PgSql extends Sql {
  close(): Promise<void>;
}

export function connectPostgres(connectionString: string): PgSql {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    query: async <T>(text: string, params?: unknown[]) => ({ rows: (await pool.query(text, params)).rows as T[] }),
    // A script runs on one connection, which is rolled back before it returns to the pool on failure.
    exec: async (text) => {
      const client = await pool.connect();
      try {
        return await client.query(text);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Postgres in this process (PGlite, WASM), for development without a database server. Forgets everything on exit. */
export async function memoryPostgres(): Promise<PgSql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  return {
    query: async <T>(text: string, params?: unknown[]) => ({ rows: (await db.query<T>(text, params)).rows }),
    exec: (text) => db.exec(text),
    close: () => db.close(),
  };
}

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);
// Any constant: serialises migrations when several gateway instances start at once.
const MIGRATION_LOCK = 4_242_001;

/**
 * Applies migrations/*.sql in name order, each once. A migration is never edited
 * after it ships: a schema change is a new file.
 */
export async function migrate(sql: Sql, dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  await sql.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  const done = new Set((await sql.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  for (const file of files) {
    if (done.has(file)) continue;
    const script = await readFile(new URL(file, dir), "utf8");
    // One script on one connection: the transaction lock makes a second instance that raced
    // to the same migration wait, then fail on the applied DDL and restart cleanly.
    try {
      await sql.exec(
        `BEGIN;\nSELECT pg_advisory_xact_lock(${MIGRATION_LOCK});\n${script}\nINSERT INTO schema_migrations (name) VALUES ('${file.replaceAll("'", "''")}');\nCOMMIT;`,
      );
    } catch (e) {
      await sql.exec("ROLLBACK").catch(() => undefined);
      throw new Error(`migration ${file} failed: ${(e as Error).message}`, { cause: e });
    }
    applied.push(file);
  }
  return applied;
}
