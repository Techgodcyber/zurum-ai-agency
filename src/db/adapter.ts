import { mkdirSync } from "node:fs";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "db" });

/**
 * Minimal database interface the app codes against. Two implementations back it:
 *  - PGlite (embedded Postgres) for local dev — zero install, real PG SQL.
 *  - node-postgres Pool for production (when DATABASE_URL is set).
 * Because both speak real Postgres, the schema and queries are identical.
 */
export interface Db {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** Run a multi-statement script (no params) — used for migrations. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly kind: "pglite" | "postgres";
}

/** Embedded Postgres (dev). */
async function makePglite(dir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir);
  await pg.waitReady;
  log.info({ dir }, "using embedded PGlite (dev)");
  return {
    kind: "pglite",
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pg.query<T>(sql, params as unknown[]);
      return res.rows;
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async close() {
      await pg.close();
    },
  };
}

/** Real Postgres (prod). */
async function makePostgres(connectionString: string): Promise<Db> {
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString });
  // Fail fast if the URL is wrong.
  await pool.query("SELECT 1");
  log.info("using Postgres (DATABASE_URL)");
  return {
    kind: "postgres",
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

export function createDb(): Promise<Db> {
  return env.DATABASE_URL
    ? makePostgres(env.DATABASE_URL)
    : makePglite(env.PGLITE_DIR);
}
