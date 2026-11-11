import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/index.js";

/**
 * Magic-link sessions for the customer panel. A customer asks for their
 * dashboard in chat; we mint a short-lived token, store only its hash, and send
 * the link. Opening it resolves the token to the customer's account — no
 * password, low friction, and the link expires. Reusable within its window so
 * they can navigate the panel.
 */

const LINK_MINUTES = 60; // one-time login link from chat
const SESSION_DAYS = 30; // the browser session cookie after logging in
const hash = (t: string): string => createHash("sha256").update(t).digest("hex");

async function mint(userId: string, ms: number): Promise<string> {
  const db = await getDb();
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + ms).toISOString();
  await db.query(`INSERT INTO panel_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [
    hash(token),
    userId,
    expires,
  ]);
  await db.query(`DELETE FROM panel_tokens WHERE expires_at <= now()`).catch(() => {});
  return token;
}

/** A short-lived one-time login LINK (sent in chat). */
export function createPanelToken(userId: string): Promise<string> {
  return mint(userId, LINK_MINUTES * 60_000);
}

/** A long-lived browser SESSION token (the cookie), minted after the link opens. */
export function createPanelSession(userId: string): Promise<string> {
  return mint(userId, SESSION_DAYS * 86_400_000);
}

/** Invalidate a session/link token (logout). */
export async function destroyPanelToken(token: string | null): Promise<void> {
  if (!token) return;
  const db = await getDb();
  await db.query(`DELETE FROM panel_tokens WHERE token_hash = $1`, [hash(token)]);
}

/** Resolve a panel token to its user id, or null if invalid/expired. */
export async function userForPanelToken(token: string | null): Promise<string | null> {
  if (!token) return null;
  const db = await getDb();
  const rows = await db.query<{ user_id: string }>(
    `SELECT user_id FROM panel_tokens WHERE token_hash = $1 AND expires_at > now()`,
    [hash(token)],
  );
  return rows[0]?.user_id ?? null;
}
