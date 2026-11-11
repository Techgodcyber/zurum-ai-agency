import { getDb } from "../db/index.js";
import { checkAvailability, registerDomain, isNamesiloConfigured } from "./namesilo.js";
import { checkDomainSpend } from "./spend-guard.js";
import { addPagesCustomDomain } from "../launch/cloudflare.js";
import { getHosting } from "../launch/hosting-store.js";
import { logger } from "../lib/logger.js";

/**
 * Register a domain on the customer's behalf — the ONE place that spends real
 * reseller money, so it is deliberately guarded and idempotent (ARCHITECTURE
 * §4.1, §5, §8):
 *   - the funded-account spend guard must pass first (24h caps);
 *   - a domain already registered for this request is never bought twice;
 *   - registration uses WHOIS privacy + auto-renew OFF (founder rule).
 *
 * This is invoked AFTER payment/approval (the publish fee bundles the domain) —
 * for now via an admin action (human-in-the-loop spend), matching §5 "only
 * Launch releases spend, post-approval".
 */

const log = logger.child({ mod: "domain-purchase" });

export interface PurchaseResult {
  status: "registered" | "already_owned" | "unavailable" | "blocked" | "failed" | "not_configured";
  domain: string;
  costUsd?: number;
  detail?: string;
  dnsTarget?: string;
}

export async function purchaseDomain(
  userId: string | null,
  siteId: string,
  rawDomain: string,
  signal?: AbortSignal,
): Promise<PurchaseResult> {
  const domain = rawDomain.trim().toLowerCase();
  if (!isNamesiloConfigured()) return { status: "not_configured", domain };
  const db = await getDb();

  // Idempotency: if we already registered this domain, don't buy it again.
  const existing = await db.query<{ status: string }>(
    `SELECT status FROM domains WHERE name = $1 AND status = 'registered' LIMIT 1`,
    [domain],
  );
  if (existing[0]) return { status: "already_owned", domain };

  const avail = await checkAvailability(domain, signal);
  if (avail.status !== "available") {
    return { status: "unavailable", domain, detail: `domain is ${avail.status}` };
  }
  const costUsd = avail.cost ?? 0;

  // SPEND GUARD — the catastrophic-loss backstop. Fails closed.
  const guard = await checkDomainSpend(costUsd);
  if (!guard.allowed) {
    return { status: "blocked", domain, costUsd, detail: guard.reason };
  }

  // Real spend happens here.
  const reg = await registerDomain(domain, 1, signal);
  if (!reg.ok) {
    log.error({ domain, detail: reg.detail }, "domain registration failed");
    return { status: "failed", domain, costUsd, detail: reg.detail };
  }

  // Record the registration (drives the spend guard + shows in admin).
  await db.query(
    `INSERT INTO domains (user_id, name, registrar, status, cost_usd, registered_at, site_id, expiry)
     VALUES ($1, $2, 'namesilo', 'registered', $3, now(), $4, (now() + interval '1 year')::date)
     ON CONFLICT DO NOTHING`,
    [userId, domain, costUsd, siteId],
  );
  // If nothing was inserted (a prior 'requested' row exists), promote that row.
  await db.query(
    `UPDATE domains SET status = 'registered', cost_usd = $2, registered_at = now(),
        site_id = COALESCE(site_id, $3), expiry = COALESCE(expiry, (now() + interval '1 year')::date)
      WHERE name = $1 AND status IN ('requested','pending')`,
    [domain, costUsd, siteId],
  );

  // Attach it to the customer's Cloudflare Pages project so SSL provisions once
  // DNS points at the site. (NameSilo DNS records for the bought domain are a
  // follow-up — the domain is in our account, so we finish DNS from there.)
  let dnsTarget: string | undefined;
  try {
    const hosting = await getHosting(siteId);
    if (hosting?.provider === "cloudflare") {
      dnsTarget = hosting.publicUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
      await addPagesCustomDomain(hosting.providerSiteId, domain, signal);
      await addPagesCustomDomain(hosting.providerSiteId, `www.${domain}`, signal);
    }
  } catch (err) {
    log.warn({ err, domain, siteId }, "post-registration domain attach failed (finish manually)");
  }

  log.info({ domain, costUsd, siteId }, "domain registered for customer");
  return { status: "registered", domain, costUsd, dnsTarget };
}
