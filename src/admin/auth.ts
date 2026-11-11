import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { isRole, type Role } from "./roles.js";

const log = logger.child({ mod: "admin-auth" });
const scryptAsync = promisify(scrypt) as (
  pw: string,
  salt: Buffer,
  len: number,
) => Promise<Buffer>;

const SESSION_DAYS = 7;

export interface Staff {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  email: string;
  name: string | null;
  role: string;
  active: boolean;
  last_login_at: string | Date | null;
  created_at: string | Date;
}

const map = (r: Row): Staff => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: isRole(r.role) ? r.role : "spectator",
  active: r.active,
  lastLoginAt: r.last_login_at ? String(r.last_login_at) : null,
  createdAt: String(r.created_at),
});

// ── Passwords (scrypt; no external dependency) ───────────

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const key = await scryptAsync(password, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(keyHex, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// ── Staff CRUD ───────────────────────────────────────────

export async function listStaff(): Promise<Staff[]> {
  const db = await getDb();
  const rows = await db.query<Row>(`SELECT * FROM staff ORDER BY created_at`);
  return rows.map(map);
}

export async function staffCount(): Promise<number> {
  const db = await getDb();
  const rows = await db.query<{ n: string }>(`SELECT count(*) AS n FROM staff`);
  return Number(rows[0]?.n ?? 0);
}

export async function createStaff(args: {
  email: string;
  name?: string | null;
  password: string;
  role: Role;
}): Promise<Staff | null> {
  const db = await getDb();
  const hash = await hashPassword(args.password);
  const rows = await db.query<Row>(
    `INSERT INTO staff (email, name, password_hash, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING
     RETURNING *`,
    [args.email.trim().toLowerCase(), args.name ?? null, hash, args.role],
  );
  if (!rows[0]) return null; // email already exists
  log.info({ email: args.email, role: args.role }, "staff created");
  return map(rows[0]);
}

export async function setStaffRole(id: string, role: Role): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE staff SET role = $2 WHERE id = $1`, [id, role]);
}

export async function setStaffActive(id: string, active: boolean): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE staff SET active = $2 WHERE id = $1`, [id, active]);
  if (!active) await db.query(`DELETE FROM staff_sessions WHERE staff_id = $1`, [id]);
}

export async function setStaffPassword(id: string, password: string): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE staff SET password_hash = $2 WHERE id = $1`, [
    id,
    await hashPassword(password),
  ]);
}

/** How many ACTIVE owners exist — used to refuse removing the last one. */
export async function activeOwnerCount(): Promise<number> {
  const db = await getDb();
  const rows = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM staff WHERE role = 'owner' AND active = true`,
  );
  return Number(rows[0]?.n ?? 0);
}

// ── Login / sessions ─────────────────────────────────────

/** Verify credentials and open a session. Returns the cookie token, or null. */
export async function login(email: string, password: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.query<Row & { password_hash: string }>(
    `SELECT * FROM staff WHERE email = $1 AND active = true`,
    [email.trim().toLowerCase()],
  );
  const row = rows[0];
  if (!row) {
    await hashPassword(password); // constant-ish work so timing doesn't leak existence
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;

  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await db.query(
    `INSERT INTO staff_sessions (token, staff_id, expires_at) VALUES ($1, $2, $3)`,
    [token, row.id, expires],
  );
  await db.query(`UPDATE staff SET last_login_at = now() WHERE id = $1`, [row.id]);
  log.info({ email: row.email }, "staff login");
  return token;
}

export async function logout(token: string): Promise<void> {
  const db = await getDb();
  await db.query(`DELETE FROM staff_sessions WHERE token = $1`, [token]);
}

/** Resolve a session cookie to the (active) staff member it belongs to. */
export async function staffForToken(token: string | null): Promise<Staff | null> {
  if (!token) return null;
  const db = await getDb();
  const rows = await db.query<Row>(
    `SELECT s.* FROM staff_sessions ss
       JOIN staff s ON s.id = ss.staff_id
      WHERE ss.token = $1 AND ss.expires_at > now() AND s.active = true`,
    [token],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Housekeeping: drop expired sessions (called on boot). */
export async function purgeExpiredSessions(): Promise<void> {
  const db = await getDb();
  await db.query(`DELETE FROM staff_sessions WHERE expires_at <= now()`);
}
