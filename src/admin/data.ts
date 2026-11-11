import { getDb } from "../db/index.js";

/**
 * Read models for the admin control centre — aggregated views over customers,
 * sites, jobs and revenue. Kept separate from the UI so the same numbers can feed
 * an API or a mobile app later.
 */

export interface Overview {
  customers: number;
  sites: number;
  sitesLive: number;
  sitesSuspended: number;
  buildsToday: number;
  buildsFailedToday: number;
  submissions: number;
  creditsOutstanding: number;
  revenueUsd: number;
  revenueNgn: number;
  topupsPaid: number;
  publishedSites: number;
  publishRevenueUsd: number;
  publishRevenueNgn: number;
  publishesPaid: number;
}

export async function overview(): Promise<Overview> {
  const db = await getDb();
  const one = async (sql: string, params: unknown[] = []): Promise<number> => {
    const rows = await db.query<{ n: string | number | null }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  };
  return {
    customers: await one(`SELECT count(*) AS n FROM users`),
    sites: await one(`SELECT count(*) AS n FROM site_hosting`),
    sitesLive: await one(`SELECT count(*) AS n FROM site_hosting WHERE suspended = false`),
    sitesSuspended: await one(`SELECT count(*) AS n FROM site_hosting WHERE suspended = true`),
    buildsToday: await one(
      `SELECT count(*) AS n FROM jobs WHERE created_at > now() - interval '24 hours'`,
    ),
    buildsFailedToday: await one(
      `SELECT count(*) AS n FROM jobs WHERE state = 'failed' AND created_at > now() - interval '24 hours'`,
    ),
    submissions: await one(`SELECT count(*) AS n FROM form_submissions`),
    creditsOutstanding: await one(`SELECT COALESCE(sum(balance),0) AS n FROM credits`),
    revenueUsd: await one(
      `SELECT COALESCE(sum(amount),0) AS n FROM topups WHERE status = 'paid' AND currency = 'USD'`,
    ),
    revenueNgn: await one(
      `SELECT COALESCE(sum(amount),0) AS n FROM topups WHERE status = 'paid' AND currency = 'NGN'`,
    ),
    topupsPaid: await one(`SELECT count(*) AS n FROM topups WHERE status = 'paid'`),
    publishedSites: await one(`SELECT count(*) AS n FROM site_publish WHERE published = true`),
    publishRevenueUsd: await one(
      `SELECT COALESCE(sum(amount),0) AS n FROM publish_orders WHERE status = 'paid' AND currency = 'USD'`,
    ),
    publishRevenueNgn: await one(
      `SELECT COALESCE(sum(amount),0) AS n FROM publish_orders WHERE status = 'paid' AND currency = 'NGN'`,
    ),
    publishesPaid: await one(`SELECT count(*) AS n FROM publish_orders WHERE status = 'paid'`),
  };
}

/** Per-site publish state (plan + published + expiry) for the Sites table. */
export async function publishInfo(): Promise<
  Record<string, { plan: string; published: boolean; until: string | null }>
> {
  const db = await getDb();
  const rows = await db.query<{
    site_id: string;
    plan: string;
    published: boolean;
    published_until: string | Date | null;
  }>(`SELECT site_id, plan, published, published_until FROM site_publish`);
  const out: Record<string, { plan: string; published: boolean; until: string | null }> = {};
  for (const r of rows) {
    out[r.site_id] = {
      plan: r.plan,
      published: r.published,
      until: r.published_until ? String(r.published_until) : null,
    };
  }
  return out;
}

/** Per-site backend usage (end-user + record counts) for the Sites table. */
export async function backendInfo(): Promise<
  Record<string, { enabled: boolean; users: number; records: number }>
> {
  const db = await getDb();
  const rows = await db.query<{ site_id: string; enabled: boolean; users: string; records: string }>(
    `SELECT b.site_id, b.enabled,
       (SELECT count(*) FROM site_users u WHERE u.site_id = b.site_id) AS users,
       (SELECT count(*) FROM site_records r WHERE r.site_id = b.site_id) AS records
     FROM site_backend b`,
  );
  const out: Record<string, { enabled: boolean; users: number; records: number }> = {};
  for (const r of rows) {
    out[r.site_id] = { enabled: r.enabled, users: Number(r.users), records: Number(r.records) };
  }
  return out;
}

export interface CustomerRow {
  userId: string;
  identities: string;
  credits: number;
  buildsUsed: number;
  editsUsed: number;
  buildLimit: number | null;
  sites: number;
  createdAt: string;
}

export async function customers(limit = 100, search = ""): Promise<CustomerRow[]> {
  const db = await getDb();
  const like = `%${search.trim().toLowerCase()}%`;
  const rows = await db.query<{
    user_id: string;
    identities: string | null;
    credits: string | number | null;
    builds_used: string | number | null;
    edits_used: string | number | null;
    build_limit: number | null;
    sites: string | number | null;
    created_at: string | Date;
  }>(
    `SELECT u.id AS user_id,
            (SELECT string_agg(i.channel || ':' || i.external_id, ', ')
               FROM identities i WHERE i.user_id = u.id) AS identities,
            COALESCE(c.balance, 0)      AS credits,
            COALESCE(q.builds_used, 0)  AS builds_used,
            COALESCE(q.edits_used, 0)   AS edits_used,
            q.build_limit               AS build_limit,
            (SELECT count(*) FROM jobs j
              WHERE j.state IN ('completed','awaiting_approval')
                AND j.input->>'chatId' IN (
                  SELECT i2.external_id FROM identities i2 WHERE i2.user_id = u.id
                )) AS sites,
            u.created_at
       FROM users u
       LEFT JOIN credits c     ON c.user_id = u.id
       LEFT JOIN build_quota q ON q.user_id = u.id
      WHERE $2 = '%%' OR lower(COALESCE(
              (SELECT string_agg(i.channel || ':' || i.external_id, ', ')
                 FROM identities i WHERE i.user_id = u.id), '')) LIKE $2
      ORDER BY u.created_at DESC
      LIMIT $1`,
    [limit, like],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    identities: r.identities ?? "(no identity)",
    credits: Number(r.credits ?? 0),
    buildsUsed: Number(r.builds_used ?? 0),
    editsUsed: Number(r.edits_used ?? 0),
    buildLimit: r.build_limit,
    sites: Number(r.sites ?? 0),
    createdAt: String(r.created_at),
  }));
}

export interface JobRow {
  id: string;
  type: string;
  state: string;
  siteId: string | null;
  chatId: string | null;
  costUsd: number;
  error: string | null;
  createdAt: string;
}

export async function jobs(limit = 100, state = ""): Promise<JobRow[]> {
  const db = await getDb();
  const rows = await db.query<{
    id: string;
    type: string;
    state: string;
    site_id: string | null;
    chat_id: string | null;
    cost_usd: string | number;
    error: string | null;
    created_at: string | Date;
  }>(
    `SELECT id, type, state,
            input->>'siteId' AS site_id,
            input->>'chatId' AS chat_id,
            cost_usd, error, created_at
       FROM jobs
      WHERE ($2 = '' OR state = $2)
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit, state],
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    state: r.state,
    siteId: r.site_id,
    chatId: r.chat_id,
    costUsd: Number(r.cost_usd),
    error: r.error,
    createdAt: String(r.created_at),
  }));
}

/** Site id → the chat that owns it, for the sites table. */
export async function siteOwners(): Promise<Record<string, string>> {
  const db = await getDb();
  const rows = await db.query<{ site_id: string; channel: string; chat_id: string }>(
    `SELECT site_id, channel, chat_id FROM intake_conversations WHERE site_id IS NOT NULL`,
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.site_id] = `${r.channel}:${r.chat_id}`;
  return out;
}

export interface FraudFlagRow {
  userId: string | null;
  txRef: string | null;
  score: number;
  action: string;
  reasons: string;
  createdAt: string;
}

/** Recent fraud/abuse flags on payment attempts, newest first. */
export async function fraudFlags(limit = 100): Promise<FraudFlagRow[]> {
  const db = await getDb();
  const rows = await db.query<{
    user_id: string | null;
    tx_ref: string | null;
    score: number | string;
    action: string;
    reasons: string;
    created_at: string | Date;
  }>(
    `SELECT user_id, tx_ref, score, action, reasons, created_at
       FROM fraud_flags ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    txRef: r.tx_ref,
    score: Number(r.score),
    action: r.action,
    reasons: r.reasons,
    createdAt: String(r.created_at),
  }));
}
