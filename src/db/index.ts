import { logger } from "../lib/logger.js";
import { createDb, type Db } from "./adapter.js";
import { SCHEMA_SQL } from "./schema.js";

const log = logger.child({ mod: "db" });

let dbPromise: Promise<Db> | null = null;

/** Apply the schema (idempotent). Safe to run on every boot. */
async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA_SQL);
  log.info("schema applied");
}

/** Lazily create + migrate the database, memoised for the process lifetime. */
export function getDb(): Promise<Db> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await createDb();
      await migrate(db);
      return db;
    })();
  }
  return dbPromise;
}

export type { Db } from "./adapter.js";
