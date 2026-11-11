import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";

/**
 * One-time WhatsApp login codes for the customer web login. The 6-digit code is
 * stored only as a sha256 hash, expires in 5 minutes, allows a few tries, and is
 * one-per-phone (a re-send overwrites the old one). The code is sent to the
 * customer's WhatsApp — proof they own the number.
 */

const log = logger.child({ mod: "login-otp" });
const OTP_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Normalise a typed phone to the digits-with-country-code form WhatsApp uses
 * (e.g. "2349169464811") — matching how Meta delivers `from` on inbound messages
 * so the identity lines up. Nigerian local "0801…" → "234801…".
 */
export function normalizePhone(input: string): string | null {
  let d = (input ?? "").replace(/[^\d]/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2); // 00 international prefix
  if (d.startsWith("0") && d.length === 11) d = "234" + d.slice(1); // NG local
  if (d.length < 8 || d.length > 15) return null; // E.164 sanity bounds
  return d;
}

/** Create/replace the login code for a phone and return the 6-digit code. */
export async function createLoginOtp(phone: string): Promise<string> {
  const db = await getDb();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expires = new Date(Date.now() + OTP_MINUTES * 60_000).toISOString();
  await db.query(
    `INSERT INTO login_otps (phone, code_hash, expires_at, attempts)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()`,
    [phone, hash(code), expires],
  );
  return code;
}

/**
 * Verify a login code. Returns true on match; increments the attempt counter and
 * fails closed after MAX_ATTEMPTS or once expired. Consumes the code on success.
 */
export async function verifyLoginOtp(phone: string, code: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query<{ code_hash: string; attempts: number }>(
    `SELECT code_hash, attempts FROM login_otps WHERE phone = $1 AND expires_at > now()`,
    [phone],
  );
  const row = rows[0];
  if (!row) return false;
  if (row.attempts >= MAX_ATTEMPTS) return false;

  const got = Buffer.from(hash(String(code).trim()));
  const want = Buffer.from(row.code_hash);
  const ok = got.length === want.length && timingSafeEqual(got, want);
  if (!ok) {
    await db.query(`UPDATE login_otps SET attempts = attempts + 1 WHERE phone = $1`, [phone]);
    return false;
  }
  await db.query(`DELETE FROM login_otps WHERE phone = $1`, [phone]); // single-use
  log.info({ phone: phone.slice(0, 5) + "…" }, "web login verified");
  return true;
}
