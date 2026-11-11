import { getDb } from "../db/index.js";
import { getBalance } from "../billing/credits.js";
import { analyticsForSites, type AnalyticsSummary } from "../growth/analytics.js";

/**
 * Read models for the customer panel — everything scoped to ONE customer's
 * user_id. A customer's sites are the sites attached to their conversations.
 */

export interface PanelSite {
  siteId: string;
  url: string | null;
  provider: string | null;
  suspended: boolean;
  plan: string;
  published: boolean;
  backendOn: boolean;
  endUsers: number;
  records: number;
}

export interface PanelOrder {
  amount: number;
  currency: string;
  status: string;
  buyer: string | null;
  createdAt: string;
}

export interface PanelData {
  name: string | null;
  phone: string | null;
  email: string | null;
  credits: number;
  sites: PanelSite[];
  domains: { name: string; status: string; expiry: string | null }[];
  sales: { orders: number; paid: number; revenue: number; currency: string };
  recentOrders: PanelOrder[];
  traffic: AnalyticsSummary;
}

/** True if this site belongs to this customer (guards downloads/data access). */
export async function userOwnsSite(userId: string, siteId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM intake_conversations WHERE user_id = $1 AND site_id = $2`,
    [userId, siteId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function panelData(userId: string): Promise<PanelData> {
  const db = await getDb();

  const profile = (
    await db.query<{ name: string | null; phone: string | null; email: string | null }>(
      `SELECT name, phone, email FROM users WHERE id = $1`,
      [userId],
    )
  )[0];

  const siteRows = await db.query<{
    site_id: string;
    public_url: string | null;
    provider: string | null;
    suspended: boolean | null;
    plan: string | null;
    published: boolean | null;
    backend_on: boolean | null;
    end_users: string;
    records: string;
  }>(
    `SELECT DISTINCT c.site_id,
        h.public_url, h.provider, h.suspended,
        p.plan, p.published,
        b.enabled AS backend_on,
        (SELECT count(*) FROM site_users u  WHERE u.site_id = c.site_id) AS end_users,
        (SELECT count(*) FROM site_records r WHERE r.site_id = c.site_id) AS records
       FROM intake_conversations c
       LEFT JOIN site_hosting h ON h.site_id = c.site_id
       LEFT JOIN site_publish p ON p.site_id = c.site_id
       LEFT JOIN site_backend b ON b.site_id = c.site_id
      WHERE c.user_id = $1 AND c.site_id IS NOT NULL
      ORDER BY c.site_id`,
    [userId],
  );

  const domains = (
    await db.query<{ name: string; status: string; expiry: string | Date | null }>(
      `SELECT name, status, expiry FROM domains WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    )
  ).map((d) => ({ name: d.name, status: d.status, expiry: d.expiry ? String(d.expiry) : null }));

  // Store takings across all the customer's sites.
  const siteIds = siteRows.map((s) => s.site_id);
  let sales = { orders: 0, paid: 0, revenue: 0, currency: "NGN" };
  let recentOrders: PanelOrder[] = [];
  if (siteIds.length) {
    const agg = await db.query<{ orders: string; paid: string; revenue: string; currency: string }>(
      `SELECT count(*) orders, count(*) FILTER (WHERE status='paid') paid,
              COALESCE(sum(amount) FILTER (WHERE status='paid'),0) revenue,
              COALESCE(max(currency),'NGN') currency
         FROM site_orders WHERE site_id = ANY($1)`,
      [siteIds],
    );
    sales = {
      orders: Number(agg[0]?.orders ?? 0),
      paid: Number(agg[0]?.paid ?? 0),
      revenue: Number(agg[0]?.revenue ?? 0),
      currency: agg[0]?.currency ?? "NGN",
    };
    const rows = await db.query<{ amount: string; currency: string; status: string; buyer_name: string | null; buyer_email: string | null; created_at: string | Date }>(
      `SELECT amount, currency, status, buyer_name, buyer_email, created_at
         FROM site_orders WHERE site_id = ANY($1) ORDER BY created_at DESC LIMIT 8`,
      [siteIds],
    );
    recentOrders = rows.map((o) => ({
      amount: Number(o.amount),
      currency: o.currency,
      status: o.status,
      buyer: o.buyer_name ?? o.buyer_email ?? null,
      createdAt: String(o.created_at),
    }));
  }

  const traffic = await analyticsForSites(siteIds, 7);

  return {
    name: profile?.name ?? null,
    phone: profile?.phone ?? null,
    email: profile?.email ?? null,
    credits: await getBalance(userId),
    sales,
    recentOrders,
    traffic,
    sites: siteRows.map((s) => ({
      siteId: s.site_id,
      url: s.public_url,
      provider: s.provider,
      suspended: Boolean(s.suspended),
      plan: s.plan ?? "static",
      published: Boolean(s.published),
      backendOn: Boolean(s.backend_on),
      endUsers: Number(s.end_users ?? 0),
      records: Number(s.records ?? 0),
    })),
    domains,
  };
}
