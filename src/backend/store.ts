import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getDb } from "../db/index.js";
import { getHosting } from "../launch/hosting-store.js";
import { logger } from "../lib/logger.js";

/**
 * Data layer for the multi-tenant customer-site backend (ARCHITECTURE §14).
 *
 * EVERY query is scoped by site_id — that scoping IS the tenant isolation, so
 * one site can never read another's users or records. Passwords use scrypt (no
 * external dependency); session tokens are random and stored only as a sha256
 * hash. All SQL is parameterised (no string-built queries → no SQL injection).
 */

const log = logger.child({ mod: "site-backend" });
const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

const SESSION_DAYS = 30;

// ── Passwords + tokens ───────────────────────────────────

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const key = await scryptAsync(password, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(keyHex, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

// ── Types ────────────────────────────────────────────────

export interface SiteUser {
  id: string;
  email: string;
  name: string | null;
  data: Record<string, unknown>;
  emailVerified: boolean;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  data: Record<string, unknown>;
  email_verified?: boolean;
  created_at: string | Date;
  password_hash?: string;
}

const mapUser = (r: UserRow): SiteUser => ({
  id: r.id,
  email: r.email,
  name: r.name,
  data: r.data ?? {},
  emailVerified: Boolean(r.email_verified),
  createdAt: String(r.created_at),
});

// ── Per-site backend config (enable + CORS allow-list) ───

export interface SiteBackend {
  siteId: string;
  enabled: boolean;
  allowedOrigins: string[];
}

/**
 * Resolve a site's backend config. A backend exists ONLY for sites we've
 * explicitly enabled (a dynamic/dashboard build) — so a plain static site never
 * exposes an API surface. The site's own hosted origin is always added to the
 * CORS allow-list at read time, so logins work on the freshly published URL
 * even though that URL wasn't known when the backend was first enabled.
 */
export async function getSiteBackend(siteId: string): Promise<SiteBackend | null> {
  const db = await getDb();
  const rows = await db.query<{ enabled: boolean; allowed_origins: string[] }>(
    `SELECT enabled, allowed_origins FROM site_backend WHERE site_id = $1`,
    [siteId],
  );
  if (!rows[0]) return null;
  const origins = new Set(rows[0].allowed_origins ?? []);
  const hosting = await getHosting(siteId);
  const hostedOrigin = originOf(hosting?.publicUrl ?? null);
  if (hostedOrigin) origins.add(hostedOrigin); // always trust the site's own host
  return { siteId, enabled: rows[0].enabled, allowedOrigins: [...origins] };
}

/** Turn a site's backend on and register extra allowed origins (custom domains). */
export async function enableSiteBackend(siteId: string, origins: string[] = []): Promise<void> {
  const db = await getDb();
  const clean = origins.map(originOf).filter((o): o is string => Boolean(o));
  await db.query(
    `INSERT INTO site_backend (site_id, enabled, allowed_origins)
     VALUES ($1, true, $2)
     ON CONFLICT (site_id) DO UPDATE SET enabled = true,
       allowed_origins = (
         SELECT array_agg(DISTINCT o) FROM unnest(site_backend.allowed_origins || $2::text[]) AS o
       )`,
    [siteId, clean],
  );
  log.info({ siteId, origins: clean }, "site backend enabled");
}

/** Normalise a URL to its scheme://host[:port] origin (or null). */
function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// ── End-user accounts (register / login) ─────────────────

/** Register a new end-user for a site. Returns null if the email is taken. */
export async function registerUser(
  siteId: string,
  email: string,
  password: string,
  name: string | null,
): Promise<SiteUser | null> {
  const db = await getDb();
  const hash = await hashPassword(password);
  const rows = await db.query<UserRow>(
    `INSERT INTO site_users (site_id, email, password_hash, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, email) DO NOTHING
     RETURNING *`,
    [siteId, email.trim().toLowerCase(), hash, name],
  );
  if (!rows[0]) return null;
  log.info({ siteId, email }, "site user registered");
  return mapUser(rows[0]);
}

/** Verify credentials for a site's end-user. Returns the user or null. */
export async function authenticateUser(
  siteId: string,
  email: string,
  password: string,
): Promise<SiteUser | null> {
  const db = await getDb();
  const rows = await db.query<UserRow>(
    `SELECT * FROM site_users WHERE site_id = $1 AND email = $2`,
    [siteId, email.trim().toLowerCase()],
  );
  const row = rows[0];
  if (!row?.password_hash) {
    await hashPassword(password); // constant-ish work so timing doesn't leak existence
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;
  await db.query(`UPDATE site_users SET last_login_at = now() WHERE id = $1`, [row.id]);
  return mapUser(row);
}

// ── Sessions ─────────────────────────────────────────────

/** Open a session and return the bearer token (only the hash is stored). */
export async function createSession(siteId: string, userId: string): Promise<string> {
  const db = await getDb();
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await db.query(
    `INSERT INTO site_user_sessions (token_hash, site_id, user_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [tokenHash(token), siteId, userId, expires],
  );
  return token;
}

/** Resolve a bearer token to its user, scoped to the site. */
export async function userForToken(siteId: string, token: string | null): Promise<SiteUser | null> {
  if (!token) return null;
  const db = await getDb();
  const rows = await db.query<UserRow>(
    `SELECT u.* FROM site_user_sessions s
       JOIN site_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.site_id = $2 AND s.expires_at > now()`,
    [tokenHash(token), siteId],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function destroySession(token: string | null): Promise<void> {
  if (!token) return;
  const db = await getDb();
  await db.query(`DELETE FROM site_user_sessions WHERE token_hash = $1`, [tokenHash(token)]);
}

// ── Password reset ───────────────────────────────────────

const RESET_MINUTES = 30;

/**
 * Create a single-use reset token for the (site, email) user. Returns the token
 * + the user, or null if no such user — the CALLER must respond identically
 * either way so it can't be used to discover which emails are registered.
 */
export async function createPasswordReset(
  siteId: string,
  email: string,
): Promise<{ token: string; user: SiteUser } | null> {
  const db = await getDb();
  const rows = await db.query<UserRow>(
    `SELECT * FROM site_users WHERE site_id = $1 AND email = $2`,
    [siteId, email.trim().toLowerCase()],
  );
  if (!rows[0]) return null;
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + RESET_MINUTES * 60_000).toISOString();
  await db.query(
    `INSERT INTO site_password_resets (token_hash, site_id, user_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [tokenHash(token), siteId, rows[0].id, expires],
  );
  return { token, user: mapUser(rows[0]) };
}

/**
 * Consume a reset token and set the new password. Invalidates all of that
 * user's active sessions (a reset should log other devices out). Returns false
 * if the token is unknown, used, or expired.
 */
export async function resetPassword(
  siteId: string,
  token: string,
  newPassword: string,
): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query<{ user_id: string }>(
    `UPDATE site_password_resets SET used = true
      WHERE token_hash = $1 AND site_id = $2 AND used = false AND expires_at > now()
      RETURNING user_id`,
    [tokenHash(token), siteId],
  );
  const userId = rows[0]?.user_id;
  if (!userId) return false;
  const hash = await hashPassword(newPassword);
  await db.query(`UPDATE site_users SET password_hash = $2 WHERE id = $1`, [userId, hash]);
  await db.query(`DELETE FROM site_user_sessions WHERE user_id = $1`, [userId]);
  log.info({ siteId, userId }, "site user password reset");
  return true;
}

// ── Email verification ───────────────────────────────────

const VERIFY_HOURS = 48;

/** Create a single-use email-verification token for a user. */
export async function createEmailVerification(siteId: string, userId: string): Promise<string> {
  const db = await getDb();
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + VERIFY_HOURS * 3_600_000).toISOString();
  await db.query(
    `INSERT INTO site_email_verifications (token_hash, site_id, user_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [tokenHash(token), siteId, userId, expires],
  );
  return token;
}

/** Consume a verification token and mark the user's email verified. */
export async function verifyEmail(siteId: string, token: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query<{ user_id: string }>(
    `UPDATE site_email_verifications SET used = true
      WHERE token_hash = $1 AND site_id = $2 AND used = false AND expires_at > now()
      RETURNING user_id`,
    [tokenHash(token), siteId],
  );
  const userId = rows[0]?.user_id;
  if (!userId) return false;
  await db.query(`UPDATE site_users SET email_verified = true WHERE id = $1`, [userId]);
  log.info({ siteId, userId }, "site user email verified");
  return true;
}

/**
 * Find an unverified user by email to (re)send a verification link. Returns the
 * token + user, or null if no such user / already verified.
 */
export async function newVerificationFor(
  siteId: string,
  email: string,
): Promise<{ token: string; user: SiteUser } | null> {
  const db = await getDb();
  const rows = await db.query<UserRow>(
    `SELECT * FROM site_users WHERE site_id = $1 AND email = $2 AND email_verified = false`,
    [siteId, email.trim().toLowerCase()],
  );
  if (!rows[0]) return null;
  const token = await createEmailVerification(siteId, rows[0].id);
  return { token, user: mapUser(rows[0]) };
}

// ── Records (dashboard data) ─────────────────────────────

export interface SiteRecord {
  id: string;
  collection: string;
  ownerUserId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface RecordRow {
  id: string;
  collection: string;
  owner_user_id: string | null;
  data: Record<string, unknown>;
  created_at: string | Date;
  updated_at: string | Date;
}

const mapRecord = (r: RecordRow): SiteRecord => ({
  id: r.id,
  collection: r.collection,
  ownerUserId: r.owner_user_id,
  data: r.data ?? {},
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

export async function createRecord(
  siteId: string,
  collection: string,
  ownerUserId: string | null,
  data: Record<string, unknown>,
): Promise<SiteRecord> {
  const db = await getDb();
  const rows = await db.query<RecordRow>(
    `INSERT INTO site_records (site_id, collection, owner_user_id, data)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
    [siteId, collection, ownerUserId, JSON.stringify(data)],
  );
  return mapRecord(rows[0]!);
}

/**
 * List records in a collection. If ownerUserId is provided, returns ONLY that
 * user's records (private data); otherwise the collection's shared records.
 * Supports simple limit/offset pagination.
 */
export async function listRecords(
  siteId: string,
  collection: string,
  ownerUserId: string | null,
  limit = 100,
  offset = 0,
): Promise<SiteRecord[]> {
  const db = await getDb();
  const capped = Math.min(Math.max(1, limit), 500);
  const off = Math.max(0, Math.floor(offset));
  const rows = ownerUserId
    ? await db.query<RecordRow>(
        `SELECT * FROM site_records WHERE site_id = $1 AND collection = $2 AND owner_user_id = $3
         ORDER BY created_at DESC LIMIT ${capped} OFFSET ${off}`,
        [siteId, collection, ownerUserId],
      )
    : await db.query<RecordRow>(
        `SELECT * FROM site_records WHERE site_id = $1 AND collection = $2
         ORDER BY created_at DESC LIMIT ${capped} OFFSET ${off}`,
        [siteId, collection],
      );
  return rows.map(mapRecord);
}

/** Update a record's data — only if it belongs to this site (and owner, when scoped). */
export async function updateRecord(
  siteId: string,
  id: string,
  ownerUserId: string | null,
  data: Record<string, unknown>,
): Promise<SiteRecord | null> {
  const db = await getDb();
  const rows = ownerUserId
    ? await db.query<RecordRow>(
        `UPDATE site_records SET data = $4::jsonb, updated_at = now()
          WHERE id = $1 AND site_id = $2 AND owner_user_id = $3 RETURNING *`,
        [id, siteId, ownerUserId, JSON.stringify(data)],
      )
    : await db.query<RecordRow>(
        `UPDATE site_records SET data = $3::jsonb, updated_at = now()
          WHERE id = $1 AND site_id = $2 RETURNING *`,
        [id, siteId, JSON.stringify(data)],
      );
  return rows[0] ? mapRecord(rows[0]) : null;
}

/** Recent end-users of a site (for the owner's "who signed up" view). */
export async function listSiteUsers(siteId: string, limit = 20): Promise<SiteUser[]> {
  const db = await getDb();
  const capped = Math.min(Math.max(1, limit), 100);
  const rows = await db.query<UserRow>(
    `SELECT * FROM site_users WHERE site_id = $1 ORDER BY created_at DESC LIMIT ${capped}`,
    [siteId],
  );
  return rows.map(mapUser);
}

/** Delete a record — only if it belongs to this site (and owner, when scoped). */
export async function deleteRecord(
  siteId: string,
  id: string,
  ownerUserId: string | null,
): Promise<boolean> {
  const db = await getDb();
  const rows = ownerUserId
    ? await db.query<{ id: string }>(
        `DELETE FROM site_records WHERE id = $1 AND site_id = $2 AND owner_user_id = $3 RETURNING id`,
        [id, siteId, ownerUserId],
      )
    : await db.query<{ id: string }>(
        `DELETE FROM site_records WHERE id = $1 AND site_id = $2 RETURNING id`,
        [id, siteId],
      );
  return rows.length > 0;
}

/** Counts for the admin panel (how much a site's backend is being used). */
export async function backendStats(siteId: string): Promise<{ users: number; records: number }> {
  const db = await getDb();
  const u = await db.query<{ n: string }>(`SELECT count(*) n FROM site_users WHERE site_id = $1`, [siteId]);
  const r = await db.query<{ n: string }>(`SELECT count(*) n FROM site_records WHERE site_id = $1`, [siteId]);
  return { users: Number(u[0]?.n ?? 0), records: Number(r[0]?.n ?? 0) };
}
