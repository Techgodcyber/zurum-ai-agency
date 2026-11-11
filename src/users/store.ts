import { getDb } from "../db/index.js";

/**
 * Customer identity across channels. Each (channel, external_id) maps to exactly
 * one user; the same person on Telegram + WhatsApp + web can be linked to one
 * user record so Zurum behaves as a single agency, not separate bots.
 */
export interface User {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  verifiedAt: string | null;
}

/**
 * Resolve the user for a channel sender, creating one on first contact. Safe
 * against the create race via ON CONFLICT + re-select.
 */
export async function resolveUserId(
  channel: string,
  externalId: string,
): Promise<string> {
  const db = await getDb();

  const existing = await db.query<{ user_id: string }>(
    `SELECT user_id FROM identities WHERE channel = $1 AND external_id = $2`,
    [channel, externalId],
  );
  if (existing[0]) return existing[0].user_id;

  const created = await db.query<{ id: string }>(
    `INSERT INTO users (channel) VALUES ($1) RETURNING id`,
    [channel],
  );
  const userId = created[0]!.id;

  await db.query(
    `INSERT INTO identities (user_id, channel, external_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (channel, external_id) DO NOTHING`,
    [userId, channel, externalId],
  );

  // If a concurrent insert won the race, that identity points at a different
  // user — use whichever is now stored (and the orphan user is harmless).
  const settled = await db.query<{ user_id: string }>(
    `SELECT user_id FROM identities WHERE channel = $1 AND external_id = $2`,
    [channel, externalId],
  );
  return settled[0]!.user_id;
}

/** Record the customer's phone (from web OTP login) if not already set. */
export async function setUserPhone(userId: string, phone: string): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE users SET phone = COALESCE(phone, $2) WHERE id = $1`, [userId, phone]);
}

/** The customer's chosen/detected payment currency (NGN, USD, …), or null. */
export async function getUserCurrency(userId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.query<{ currency: string | null }>(
    `SELECT currency FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.currency ?? null;
}

/** Remember the customer's payment currency so we don't ask again. */
export async function setUserCurrency(userId: string, currency: string): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE users SET currency = $2 WHERE id = $1`, [userId, currency]);
}

/** Link a second channel identity to an existing user (cross-channel continuity). */
export async function linkIdentity(
  userId: string,
  channel: string,
  externalId: string,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO identities (user_id, channel, external_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (channel, external_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [userId, channel, externalId],
  );
}
