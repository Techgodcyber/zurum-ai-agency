import { getDb } from "../db/index.js";
import { getNum } from "../config/settings.js";
import { enableSiteBackend } from "../backend/store.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "publish" });

/**
 * Publish billing. A site is built and previewed for FREE; taking it live is the
 * annual host+domain fee. Two plans:
 *   - static  → a normal site (hosted free on Cloudflare) → cheaper fee
 *   - dynamic → a dashboard / portal / web app (runs on our server) → higher fee
 *
 * Edits are billed separately (free allowance → credits). This module only owns
 * the one-time annual publish charge and the published/expiry state.
 */

export type Plan = "static" | "dynamic";

export interface SitePublish {
  siteId: string;
  plan: Plan;
  published: boolean;
  priceUsd: number | null;
  publishedUntil: string | null;
}

interface PubRow {
  site_id: string;
  plan: string;
  published: boolean;
  price_usd: number | null;
  published_until: string | Date | null;
}

const asPlan = (v: string): Plan => (v === "dynamic" ? "dynamic" : "static");

// Clear backend indicators → the dynamic (dashboard/app) tier. A plain brochure
// site, or a static site with a contact form, stays on the cheaper static tier.
const DYNAMIC_RE =
  /\b(dashboard|admin panel|admin dashboard|control panel|portal|web ?app|saas|crm|log ?in|login|sign ?up|signup|register|registration|user account|members? area|members?-only|authentication|auth system|backend|user data|database|e-?commerce|online (?:shop|store)|shop|store|storefront|sell (?:online|products?|things?)|add to cart|checkout|marketplace|boutique)\b/i;

/** Classify a build spec into a pricing plan. */
export function detectPlan(spec: string): Plan {
  return DYNAMIC_RE.test(spec) ? "dynamic" : "static";
}

/** The annual publish price (USD) for a plan, from live settings. */
export function publishPriceUsd(plan: Plan): number {
  return getNum(plan === "dynamic" ? "publish_price_dynamic_usd" : "publish_price_static_usd");
}

/** Record a site's plan at build time (never downgrades an already-published site). */
export async function setSitePlan(siteId: string, plan: Plan): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO site_publish (site_id, plan) VALUES ($1, $2)
     ON CONFLICT (site_id) DO UPDATE SET plan = $2, updated_at = now()
       WHERE site_publish.published = false`,
    [siteId, plan],
  );
}

export async function getSitePublish(siteId: string): Promise<SitePublish | null> {
  const db = await getDb();
  const rows = await db.query<PubRow>(`SELECT * FROM site_publish WHERE site_id = $1`, [siteId]);
  const r = rows[0];
  return r
    ? {
        siteId: r.site_id,
        plan: asPlan(r.plan),
        published: r.published,
        priceUsd: r.price_usd,
        publishedUntil: r.published_until ? String(r.published_until) : null,
      }
    : null;
}

export async function isPublished(siteId: string): Promise<boolean> {
  return Boolean((await getSitePublish(siteId))?.published);
}

/** The effective plan for a site (recorded at build; defaults to static). */
export async function planFor(siteId: string): Promise<Plan> {
  return (await getSitePublish(siteId))?.plan ?? "static";
}

/** Flip a site to published with a 1-year term. Idempotent-safe to call again. */
export async function markPublished(
  siteId: string,
  plan: Plan,
  priceUsd: number,
  payRef: string,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO site_publish
       (site_id, plan, published, price_usd, pay_ref, published_at, published_until, updated_at)
     VALUES ($1, $2, true, $3, $4, now(), now() + interval '1 year', now())
     ON CONFLICT (site_id) DO UPDATE SET
       published = true, plan = EXCLUDED.plan, price_usd = EXCLUDED.price_usd,
       pay_ref = EXCLUDED.pay_ref, published_at = now(), expired = false,
       published_until = now() + interval '1 year', updated_at = now()`,
    [siteId, plan, priceUsd, payRef],
  );
  // A DYNAMIC site's real backend (working login/accounts/dashboard) is only
  // activated once the site is PAID FOR + published — never during the free
  // preview. Until then the site's login UI is visible but inert.
  if (plan === "dynamic") {
    await enableSiteBackend(siteId).catch((err) =>
      log.warn({ err, siteId }, "publish: enable backend failed"),
    );
    log.info({ siteId }, "dynamic site published — backend activated");
  }
}

// ── Preview expiry (optional; the sweep runs only when the setting > 0) ──

/** Unpaid, un-expired, live previews older than `hours` — candidates to expire. */
export async function expiredPreviewIds(hours: number): Promise<string[]> {
  const db = await getDb();
  const rows = await db.query<{ site_id: string }>(
    `SELECT sp.site_id
       FROM site_publish sp
       JOIN site_hosting sh ON sh.site_id = sp.site_id
      WHERE sp.published = false
        AND sp.expired = false
        AND sh.suspended = false
        AND sp.created_at < now() - ($1 * interval '1 hour')`,
    [hours],
  );
  return rows.map((r) => r.site_id);
}

export async function markExpired(siteId: string): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE site_publish SET expired = true, updated_at = now() WHERE site_id = $1`, [siteId]);
}

// ── Publish payment orders (mirrors topups) ──────────────

export interface PublishOrder {
  txRef: string;
  userId: string | null;
  siteId: string;
  plan: Plan;
  priceUsd: number;
  amount: number;
  currency: string;
  status: string;
}

interface OrderRow {
  tx_ref: string;
  user_id: string | null;
  site_id: string;
  plan: string;
  price_usd: number;
  amount: string | number;
  currency: string;
  status: string;
}

const mapOrder = (r: OrderRow): PublishOrder => ({
  txRef: r.tx_ref,
  userId: r.user_id,
  siteId: r.site_id,
  plan: asPlan(r.plan),
  priceUsd: r.price_usd,
  amount: Number(r.amount),
  currency: r.currency,
  status: r.status,
});

export async function createPublishOrder(o: {
  txRef: string;
  userId: string | null;
  siteId: string;
  plan: Plan;
  priceUsd: number;
  amount: number;
  currency: string;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO publish_orders (tx_ref, user_id, site_id, plan, price_usd, amount, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [o.txRef, o.userId, o.siteId, o.plan, o.priceUsd, o.amount, o.currency],
  );
}

export async function getPublishOrder(txRef: string): Promise<PublishOrder | null> {
  const db = await getDb();
  const rows = await db.query<OrderRow>(`SELECT * FROM publish_orders WHERE tx_ref = $1`, [txRef]);
  return rows[0] ? mapOrder(rows[0]) : null;
}

/**
 * Mark an order paid exactly once. Returns the order if THIS call flipped it
 * (so the caller publishes the site), or null if it was already paid.
 */
export async function markPublishOrderPaid(txRef: string): Promise<PublishOrder | null> {
  const db = await getDb();
  const rows = await db.query<OrderRow>(
    `UPDATE publish_orders SET status = 'paid', paid_at = now()
      WHERE tx_ref = $1 AND status <> 'paid'
      RETURNING *`,
    [txRef],
  );
  return rows[0] ? mapOrder(rows[0]) : null;
}
