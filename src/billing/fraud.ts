import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";

/**
 * Lightweight fraud/abuse scoring for payment attempts (ARCHITECTURE §14.4).
 *
 * Crediting is already safe — a top-up is only credited after the provider
 * verifies a real successful payment, and markPaid is idempotent. So this does
 * NOT guard double-credit. What it catches is the abuse that happens BEFORE that:
 * card-testing (rapidly spinning up checkouts to probe stolen cards) and
 * credit-farming (a burst of fresh accounts). It scores an attempt, records a
 * flag for staff, and only blocks at an extreme velocity threshold so a real
 * customer retrying a payment is never turned away.
 */

const log = logger.child({ mod: "fraud" });

export type FraudAction = "allow" | "review" | "block";
export interface FraudVerdict {
  score: number; // 0-100
  action: FraudAction;
  reasons: string[];
}

// Known throwaway inbox providers — a weak signal on its own, one input among many.
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "temp-mail.org", "yopmail.com", "trashmail.com", "getnada.com", "mail7.io",
  "sharklasers.com", "throwawaymail.com", "dispostable.com", "maildrop.cc",
]);

export function isDisposableEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = email.split("@")[1]?.toLowerCase();
  return domain ? DISPOSABLE_DOMAINS.has(domain) : false;
}

/**
 * Score a top-up attempt for the given user. Reads recent history from the DB;
 * on any error it fails OPEN (allow) — fraud scoring must never break checkout.
 */
export async function scoreTopup(input: {
  userId: string;
  amount: number;
  currency: string;
}): Promise<FraudVerdict> {
  const reasons: string[] = [];
  let score = 0;
  try {
    const db = await getDb();

    // Velocity: checkouts this user created in the last 10 minutes. A human tops
    // up once; a card-tester spins up many. This is the strongest signal.
    const recent = await db.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM topups
        WHERE user_id = $1 AND created_at > now() - interval '10 minutes'`,
      [input.userId],
    );
    const recentN = Number(recent[0]?.n ?? 0);
    if (recentN >= 8) { score += 70; reasons.push(`${recentN} checkouts in 10 min (card-testing pattern)`); }
    else if (recentN >= 4) { score += 40; reasons.push(`${recentN} checkouts in 10 min`); }

    // Abandoned attempts: many pending, none paid → probing.
    const pending = await db.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM topups
        WHERE user_id = $1 AND status = 'pending' AND created_at > now() - interval '1 hour'`,
      [input.userId],
    );
    const pendingN = Number(pending[0]?.n ?? 0);
    if (pendingN >= 6) { score += 25; reasons.push(`${pendingN} unpaid attempts in the last hour`); }

    // Brand-new account making a payment within seconds of signup.
    const acct = await db.query<{ age_secs: number | string; email: string | null }>(
      `SELECT extract(epoch FROM (now() - created_at)) AS age_secs, email
         FROM users WHERE id = $1`,
      [input.userId],
    );
    const ageSecs = Number(acct[0]?.age_secs ?? 999999);
    if (ageSecs < 60) { score += 20; reasons.push("payment within 60s of account creation"); }
    if (isDisposableEmail(acct[0]?.email)) { score += 15; reasons.push("disposable email domain"); }
  } catch (err) {
    // Fail open — never block a real customer because a query hiccuped.
    log.warn({ err: (err as Error).message }, "fraud scoring failed; allowing");
    return { score: 0, action: "allow", reasons: [] };
  }

  score = Math.min(100, score);
  const action: FraudAction = score >= 80 ? "block" : score >= 40 ? "review" : "allow";
  return { score, action, reasons };
}

/** Persist a flag for staff visibility (best-effort). */
export async function recordFraudFlag(
  userId: string,
  txRef: string | null,
  v: FraudVerdict,
): Promise<void> {
  if (v.action === "allow") return;
  try {
    const db = await getDb();
    await db.query(
      `INSERT INTO fraud_flags (user_id, tx_ref, score, action, reasons)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, txRef, v.score, v.action, v.reasons.join("; ")],
    );
    log.warn({ userId, txRef, score: v.score, action: v.action, reasons: v.reasons }, "fraud flag");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "could not record fraud flag");
  }
}
