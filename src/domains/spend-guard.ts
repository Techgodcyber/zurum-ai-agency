import { getDb } from "../db/index.js";
import { getNum } from "../config/settings.js";
import { logger } from "../lib/logger.js";

/**
 * Funded-account spend guard (ARCHITECTURE §4.1 — CATASTROPHIC-1).
 *
 * The reseller wallet is real money. A bug, a loop, or a prompt-injection must
 * NOT be able to register hundreds of domains before anyone notices. Every
 * registration passes this guard first: it caps how many domains and how much $
 * can be spent in a rolling 24h window. Both caps are admin-configurable knobs.
 */

const log = logger.child({ mod: "spend-guard" });

export interface SpendDecision {
  allowed: boolean;
  reason?: string;
  todayCount: number;
  todayUsd: number;
  maxCount: number;
  maxUsd: number;
}

/** Registrations + $ spent in the last 24h (status='registered'). */
async function spentToday(): Promise<{ count: number; usd: number }> {
  const db = await getDb();
  const rows = await db.query<{ n: string; s: string }>(
    `SELECT count(*) AS n, COALESCE(sum(cost_usd), 0) AS s
       FROM domains
      WHERE status = 'registered' AND registered_at > now() - interval '24 hours'`,
  );
  return { count: Number(rows[0]?.n ?? 0), usd: Number(rows[0]?.s ?? 0) };
}

/**
 * Decide whether registering ONE more domain at `costUsd` is within the 24h
 * caps. Fails CLOSED (blocks) — the safe direction for spending real money.
 */
export async function checkDomainSpend(costUsd: number): Promise<SpendDecision> {
  const maxCount = getNum("domain_daily_max_count");
  const maxUsd = getNum("domain_daily_max_usd");
  const { count, usd } = await spentToday();
  const wouldCount = count + 1;
  const wouldUsd = usd + Math.max(0, costUsd);
  const allowed = wouldCount <= maxCount && wouldUsd <= maxUsd;
  const decision: SpendDecision = {
    allowed,
    todayCount: count,
    todayUsd: usd,
    maxCount,
    maxUsd,
  };
  if (!allowed) {
    decision.reason =
      wouldCount > maxCount
        ? `daily domain count cap reached (${count}/${maxCount})`
        : `daily domain spend cap reached ($${usd.toFixed(2)}/$${maxUsd} + $${costUsd.toFixed(2)})`;
    log.warn({ ...decision, costUsd }, "domain spend BLOCKED by guard");
  }
  return decision;
}
