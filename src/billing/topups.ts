import { getDb } from "../db/index.js";

/**
 * Top-up records — one per payment attempt, keyed by tx_ref. Crediting is
 * idempotent: `markPaid` only succeeds on a still-'pending' row, so tapping
 * "I've paid" twice (or a future webhook racing it) can never double-credit.
 */

export interface Topup {
  userId: string | null;
  txRef: string;
  credits: number;
  amount: number;
  currency: string;
  status: string;
}

export async function createTopup(t: {
  userId: string;
  txRef: string;
  credits: number;
  amount: number;
  currency: string;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO topups (user_id, tx_ref, credits, amount, currency)
     VALUES ($1, $2, $3, $4, $5)`,
    [t.userId, t.txRef, t.credits, t.amount, t.currency],
  );
}

export async function getTopup(txRef: string): Promise<Topup | null> {
  const db = await getDb();
  const rows = await db.query<{
    user_id: string | null;
    tx_ref: string;
    credits: number | string;
    amount: number | string;
    currency: string;
    status: string;
  }>(`SELECT user_id, tx_ref, credits, amount, currency, status FROM topups WHERE tx_ref = $1`, [txRef]);
  const r = rows[0];
  return r
    ? {
        userId: r.user_id,
        txRef: r.tx_ref,
        credits: Number(r.credits),
        amount: Number(r.amount),
        currency: r.currency,
        status: r.status,
      }
    : null;
}

/**
 * Atomically flip a pending top-up to 'paid'. Returns the credits to grant if
 * THIS call did the flip, or null if it was already paid/failed (idempotency).
 */
export async function markPaid(txRef: string): Promise<number | null> {
  const db = await getDb();
  const rows = await db.query<{ credits: number | string }>(
    `UPDATE topups SET status = 'paid'
      WHERE tx_ref = $1 AND status = 'pending'
      RETURNING credits`,
    [txRef],
  );
  return rows[0] ? Number(rows[0].credits) : null;
}
