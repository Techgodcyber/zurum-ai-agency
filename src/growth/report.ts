import { getDb } from "../db/index.js";

/**
 * Growth report — a REAL weekly snapshot of a customer's sites (§15: every stat
 * is real). Compares this week vs last week across traffic, signups, sales and
 * enquiries, and offers a couple of rule-based, honest tips (no fabricated
 * numbers, no model needed).
 */

export interface WeekMetrics {
  views: number;
  visitors: number;
  signups: number;
  orders: number;
  revenue: number;
  currency: string;
  enquiries: number;
}
export interface Report {
  now: WeekMetrics;
  prev: WeekMetrics;
  tips: string[];
}

/** All of a customer's site ids (across channels). */
export async function siteIdsForUser(userId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.query<{ site_id: string }>(
    `SELECT DISTINCT site_id FROM intake_conversations WHERE user_id = $1 AND site_id IS NOT NULL`,
    [userId],
  );
  return rows.map((r) => r.site_id);
}

export async function buildReport(siteIds: string[]): Promise<Report | null> {
  if (!siteIds.length) return null;
  const now = await metrics(siteIds, 0); // last 7 days
  const prev = await metrics(siteIds, 7); // the 7 days before that
  return { now, prev, tips: tipsFor(now, prev) };
}

async function metrics(siteIds: string[], offset: number): Promise<WeekMetrics> {
  const db = await getDb();
  // offset is a controlled integer (0 or 7), safe to inline as an interval.
  const win = `created_at >= now() - interval '${offset + 7} days' AND created_at < now() - interval '${offset} days'`;
  const one = async (sql: string): Promise<Record<string, string>> =>
    (await db.query<Record<string, string>>(sql, [siteIds]))[0] ?? {};

  const t = await one(`SELECT count(*) views, count(DISTINCT vid) visitors FROM site_events WHERE site_id = ANY($1) AND ${win}`);
  const s = await one(`SELECT count(*) n FROM site_users WHERE site_id = ANY($1) AND ${win}`);
  const o = await one(
    `SELECT count(*) FILTER (WHERE status='paid') orders,
            COALESCE(sum(amount) FILTER (WHERE status='paid'),0) revenue,
            COALESCE(max(currency),'NGN') currency
       FROM site_orders WHERE site_id = ANY($1) AND ${win}`,
  );
  const e = await one(`SELECT count(*) n FROM form_submissions WHERE site_id = ANY($1) AND ${win}`);

  return {
    views: Number(t.views ?? 0),
    visitors: Number(t.visitors ?? 0),
    signups: Number(s.n ?? 0),
    orders: Number(o.orders ?? 0),
    revenue: Number(o.revenue ?? 0),
    currency: o.currency ?? "NGN",
    enquiries: Number(e.n ?? 0),
  };
}

function tipsFor(now: WeekMetrics, prev: WeekMetrics): string[] {
  const tips: string[] = [];
  if (now.views === 0) {
    tips.push("No visitors yet this week — share your site link on WhatsApp status, Instagram and your bio.");
  } else if (now.signups === 0 && now.views > 10) {
    tips.push("You're getting visitors but no sign-ups — make your call-to-action clearer or offer a small incentive.");
  }
  if (now.orders === 0 && now.views > 20) {
    tips.push("Plenty of visitors but no sales yet — add clear prices and a few good product photos.");
  }
  if (prev.views > 0 && now.views > prev.views) {
    tips.push("Traffic is up vs last week 🎉 — keep doing what's bringing people in.");
  }
  if (now.enquiries > 0) {
    tips.push(`You got ${now.enquiries} enquir${now.enquiries === 1 ? "y" : "ies"} — reply fast to win the business.`);
  }
  if (!tips.length) tips.push("Steady week. Try sharing your link somewhere new to grow your reach.");
  return tips.slice(0, 2);
}

/** A friendly chat message for a report. */
export function formatReport(r: Report): string {
  const d = (nowV: number, prevV: number): string => {
    if (prevV === 0) return nowV > 0 ? " _(new)_" : "";
    const pct = Math.round(((nowV - prevV) / prevV) * 100);
    return pct === 0 ? "" : ` _(${pct > 0 ? "▲" : "▼"}${Math.abs(pct)}%)_`;
  };
  const n = r.now;
  return (
    `📊 *Your week*\n\n` +
    `👀 Visitors: *${n.visitors}*${d(n.visitors, r.prev.visitors)}\n` +
    `📄 Page views: *${n.views}*${d(n.views, r.prev.views)}\n` +
    `✍️ New sign-ups: *${n.signups}*${d(n.signups, r.prev.signups)}\n` +
    `🛒 Sales: *${n.orders}* — ${n.currency} ${n.revenue.toLocaleString()}${d(n.revenue, r.prev.revenue)}\n` +
    `📬 Enquiries: *${n.enquiries}*${d(n.enquiries, r.prev.enquiries)}\n\n` +
    r.tips.map((t) => `💡 ${t}`).join("\n")
  );
}
