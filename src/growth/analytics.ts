import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";

/**
 * Privacy-friendly page analytics for the Growth Engine. Every pageview on a
 * published site pings /track; we store a lightweight event (no PII — just a
 * random 1st-party visitor id for a rough unique count) and aggregate it into
 * real traffic numbers. HARD RULE (§15): every stat shown is REAL, never faked.
 */

const log = logger.child({ mod: "analytics" });

export async function recordEvent(
  siteId: string,
  vid: string | null,
  path: string | null,
  ref: string | null,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO site_events (site_id, vid, path, ref) VALUES ($1, $2, $3, $4)`,
    [siteId, vid?.slice(0, 40) ?? null, path?.slice(0, 300) ?? null, ref?.slice(0, 120) ?? null],
  );
}

export interface DayPoint {
  day: string;
  views: number;
  visitors: number;
}
export interface AnalyticsSummary {
  views: number;
  visitors: number;
  series: DayPoint[];
  topPages: { path: string; views: number }[];
  topRefs: { ref: string; views: number }[];
}

/** Traffic for a single site over the last `days`. */
export async function siteAnalytics(siteId: string, days = 7): Promise<AnalyticsSummary> {
  const db = await getDb();
  const since = `now() - ($2 || ' days')::interval`;

  const totals = await db.query<{ views: string; visitors: string }>(
    `SELECT count(*) views, count(DISTINCT vid) visitors
       FROM site_events WHERE site_id = $1 AND created_at > ${since}`,
    [siteId, String(days)],
  );
  const seriesRows = await db.query<{ d: string; views: string; visitors: string }>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS d,
            count(*) AS views, count(DISTINCT vid) AS visitors
       FROM site_events WHERE site_id = $1 AND created_at > ${since}
      GROUP BY 1 ORDER BY 1`,
    [siteId, String(days)],
  );
  const pages = await db.query<{ path: string; views: string }>(
    `SELECT COALESCE(path,'/') path, count(*) views
       FROM site_events WHERE site_id = $1 AND created_at > ${since}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
    [siteId, String(days)],
  );
  const refs = await db.query<{ ref: string; views: string }>(
    `SELECT ref, count(*) views
       FROM site_events WHERE site_id = $1 AND created_at > ${since} AND ref IS NOT NULL AND ref <> ''
      GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
    [siteId, String(days)],
  );

  return {
    views: Number(totals[0]?.views ?? 0),
    visitors: Number(totals[0]?.visitors ?? 0),
    series: seriesRows.map((r) => ({ day: r.d, views: Number(r.views), visitors: Number(r.visitors) })),
    topPages: pages.map((r) => ({ path: r.path, views: Number(r.views) })),
    topRefs: refs.map((r) => ({ ref: r.ref, views: Number(r.views) })),
  };
}

/** Views + visitors for a set of sites over a window (for the customer overview). */
export async function trafficForSites(
  siteIds: string[],
  days = 7,
): Promise<{ views: number; visitors: number }> {
  if (!siteIds.length) return { views: 0, visitors: 0 };
  const db = await getDb();
  const rows = await db.query<{ views: string; visitors: string }>(
    `SELECT count(*) views, count(DISTINCT vid) visitors
       FROM site_events WHERE site_id = ANY($1) AND created_at > now() - ($2 || ' days')::interval`,
    [siteIds, String(days)],
  );
  return { views: Number(rows[0]?.views ?? 0), visitors: Number(rows[0]?.visitors ?? 0) };
}

/** Aggregate traffic (views/visitors + daily series + top pages) across sites. */
export async function analyticsForSites(siteIds: string[], days = 7): Promise<AnalyticsSummary> {
  if (!siteIds.length) return { views: 0, visitors: 0, series: [], topPages: [], topRefs: [] };
  const db = await getDb();
  const since = `now() - ($2 || ' days')::interval`;
  const totals = await db.query<{ views: string; visitors: string }>(
    `SELECT count(*) views, count(DISTINCT vid) visitors FROM site_events
      WHERE site_id = ANY($1) AND created_at > ${since}`,
    [siteIds, String(days)],
  );
  const seriesRows = await db.query<{ d: string; views: string; visitors: string }>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS d,
            count(*) AS views, count(DISTINCT vid) AS visitors FROM site_events
      WHERE site_id = ANY($1) AND created_at > ${since} GROUP BY 1 ORDER BY 1`,
    [siteIds, String(days)],
  );
  const pages = await db.query<{ path: string; views: string }>(
    `SELECT COALESCE(path,'/') path, count(*) views FROM site_events
      WHERE site_id = ANY($1) AND created_at > ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
    [siteIds, String(days)],
  );
  return {
    views: Number(totals[0]?.views ?? 0),
    visitors: Number(totals[0]?.visitors ?? 0),
    series: seriesRows.map((r) => ({ day: r.d, views: Number(r.views), visitors: Number(r.visitors) })),
    topPages: pages.map((r) => ({ path: r.path, views: Number(r.views) })),
    topRefs: [],
  };
}

/** Retention sweep — drop events older than the window (called periodically). */
export async function purgeOldEvents(days = 120): Promise<void> {
  const db = await getDb();
  const r = await db.query<{ n?: string }>(
    `WITH d AS (DELETE FROM site_events WHERE created_at < now() - ($1 || ' days')::interval RETURNING 1)
     SELECT count(*) n FROM d`,
    [String(days)],
  );
  const n = Number(r[0]?.n ?? 0);
  if (n) log.info({ purged: n }, "old analytics events purged");
}
