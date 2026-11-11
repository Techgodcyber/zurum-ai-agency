import { getDb } from "../db/index.js";
import { getNum } from "../config/settings.js";

/**
 * Credit wallet — one balance per customer, the universal currency for paid AI
 * actions (edits beyond the free allowance, extra sites). Every change is
 * appended to a ledger for transparency and support. Spending is atomic: it only
 * succeeds if the balance covers it, so two concurrent edits can't overdraw.
 *
 * Uses the existing `credits` table (balance + ledger jsonb), one row per user
 * (credits_user_uidx). Payment top-ups call `grant`; metering calls `spend` /
 * `refund`.
 */

export interface LedgerEntry {
  at: string;
  delta: number; // +grant, -spend
  reason: string;
  balanceAfter: number;
}

interface Row {
  balance: number | string;
  ledger: LedgerEntry[] | null;
}

const MAX_LEDGER = 100; // keep the stored ledger bounded

async function wallet(userId: string): Promise<{ balance: number; topupRef: number; lowWarned: boolean }> {
  const db = await getDb();
  const rows = await db.query<{ balance: number | string; topup_ref: number | string; low_warned: boolean }>(
    `SELECT balance, topup_ref, low_warned FROM credits WHERE user_id = $1`,
    [userId],
  );
  const r = rows[0];
  return r
    ? { balance: Number(r.balance), topupRef: Number(r.topup_ref), lowWarned: r.low_warned }
    : { balance: 0, topupRef: 0, lowWarned: false };
}

export async function getBalance(userId: string): Promise<number> {
  return (await wallet(userId)).balance;
}

/**
 * Add credits. `resetRef` marks this as a TOP-UP (real payment or admin grant):
 * it becomes the new "full" reference for the low-balance alert and clears the
 * warned flag. A refund (resetRef false) doesn't move the reference.
 */
export async function grant(
  userId: string,
  amount: number,
  reason: string,
  opts?: { resetRef?: boolean },
): Promise<number> {
  if (amount <= 0) return getBalance(userId);
  const db = await getDb();
  const current = await getBalance(userId);
  const balanceAfter = current + amount;
  const entry: LedgerEntry = { at: new Date().toISOString(), delta: amount, reason, balanceAfter };
  const resetRef = opts?.resetRef ?? false;
  const rows = await db.query<{ balance: number | string }>(
    `INSERT INTO credits (user_id, balance, ledger, topup_ref, low_warned)
       VALUES ($1, $2, jsonb_build_array($3::jsonb), $5, false)
     ON CONFLICT (user_id) DO UPDATE
       SET balance = credits.balance + $4,
           ledger  = (
             CASE WHEN jsonb_array_length(credits.ledger) >= ${MAX_LEDGER}
                  THEN credits.ledger - 0
                  ELSE credits.ledger END
           ) || $3::jsonb,
           topup_ref  = CASE WHEN $6 THEN credits.balance + $4 ELSE credits.topup_ref END,
           low_warned = CASE WHEN $6 THEN false ELSE credits.low_warned END,
           updated_at = now()
     RETURNING balance`,
    [userId, amount, JSON.stringify(entry), amount, resetRef ? balanceAfter : 0, resetRef],
  );
  return Number(rows[0]!.balance);
}

/**
 * Spend credits atomically. Returns ok:false (balance unchanged) if the customer
 * can't afford it — the caller then prompts a top-up.
 */
export async function spend(
  userId: string,
  amount: number,
  reason: string,
): Promise<{ ok: boolean; balance: number; lowWarning: boolean }> {
  const db = await getDb();
  const w = await wallet(userId);
  if (w.balance < amount) return { ok: false, balance: w.balance, lowWarning: false };
  const balanceAfter = w.balance - amount;
  const entry: LedgerEntry = { at: new Date().toISOString(), delta: -amount, reason, balanceAfter };
  // Guard the balance in the WHERE clause so a concurrent spend can't overdraw.
  const rows = await db.query<{ balance: number | string }>(
    `UPDATE credits
        SET balance = balance - $2,
            ledger  = ledger || $3::jsonb,
            updated_at = now()
      WHERE user_id = $1 AND balance >= $2
      RETURNING balance`,
    [userId, amount, JSON.stringify(entry)],
  );
  if (!rows[0]) return { ok: false, balance: w.balance, lowWarning: false };
  const balance = Number(rows[0].balance);

  // Low-balance alert: warn ONCE per top-up cycle when the balance drops to the
  // configured % of the last top-up, so the customer is never cut off unaware.
  let lowWarning = false;
  const threshold = (w.topupRef * getNum("low_credit_percent")) / 100;
  if (w.topupRef > 0 && !w.lowWarned && balance <= threshold) {
    await db.query(`UPDATE credits SET low_warned = true WHERE user_id = $1`, [userId]);
    lowWarning = true;
  }
  return { ok: true, balance, lowWarning };
}

/** Give credits back (a charged action failed). */
export async function refund(userId: string, amount: number): Promise<void> {
  await grant(userId, amount, "refund (action failed)");
}

/** Recent ledger entries (newest first). */
export async function history(userId: string, limit = 10): Promise<LedgerEntry[]> {
  const db = await getDb();
  const rows = await db.query<Row>(`SELECT ledger FROM credits WHERE user_id = $1`, [userId]);
  const ledger = rows[0]?.ledger ?? [];
  return [...ledger].reverse().slice(0, limit);
}
