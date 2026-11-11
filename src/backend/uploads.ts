import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";

/**
 * Safe file uploads for site end-users (§14.4 L2 — "uploads kill shell-upload by
 * construction"). A file is accepted ONLY if its MAGIC BYTES say it's a real
 * raster image, it's stored under a RANDOM key (never the user's filename), and
 * it's served back with a fixed image content-type + nosniff — so there is no
 * interpreter and no guessable path for it to run as code. SVG is deliberately
 * rejected (it can carry script).
 */

const log = logger.child({ mod: "site-uploads" });
const UPLOAD_DIR = join(process.cwd(), ".data", "uploads");
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Identify an image by its bytes, not its extension. Returns [mime, ext] or null. */
function sniffImage(buf: Buffer): [string, string] | null {
  if (buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return ["image/png", "png"];
  if (buf.subarray(0, 3).toString("hex") === "ffd8ff") return ["image/jpeg", "jpg"];
  if (buf.subarray(0, 4).toString("ascii") === "GIF8") return ["image/gif", "gif"];
  if (
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return ["image/webp", "webp"];
  return null;
}

export interface StoredUpload {
  id: string;
  mime: string;
  size: number;
}

/**
 * Validate + store an uploaded file. Returns null if the bytes aren't an
 * allowed image type (or are empty/oversized).
 */
export async function saveUpload(
  siteId: string,
  ownerUserId: string | null,
  buf: Buffer,
): Promise<StoredUpload | null> {
  if (!buf.length || buf.length > MAX_UPLOAD_BYTES) return null;
  const sniff = sniffImage(buf);
  if (!sniff) return null;
  const [mime, ext] = sniff;
  const id = randomUUID();
  const key = `${siteId}/${id}.${ext}`;
  const full = join(UPLOAD_DIR, key);
  await mkdir(join(UPLOAD_DIR, siteId), { recursive: true });
  await writeFile(full, buf);
  const db = await getDb();
  await db.query(
    `INSERT INTO site_uploads (id, site_id, owner_user_id, mime, size, storage_key)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, siteId, ownerUserId, mime, buf.length, key],
  );
  log.info({ siteId, id, mime, size: buf.length }, "upload stored");
  return { id, mime, size: buf.length };
}

/** Fetch an upload's bytes + mime, scoped to its site. */
export async function getUpload(
  siteId: string,
  id: string,
): Promise<{ mime: string; bytes: Buffer } | null> {
  const db = await getDb();
  const rows = await db.query<{ mime: string; storage_key: string }>(
    `SELECT mime, storage_key FROM site_uploads WHERE id = $1 AND site_id = $2`,
    [id, siteId],
  );
  const row = rows[0];
  if (!row) return null;
  const full = join(UPLOAD_DIR, row.storage_key);
  if (!existsSync(full)) return null;
  return { mime: row.mime, bytes: await readFile(full) };
}
