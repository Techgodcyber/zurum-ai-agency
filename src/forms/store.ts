import { getDb } from "../db/index.js";

/**
 * Form submissions from generated sites — the "light dynamic" tier. A static page
 * posts to /f/<siteId> on our server, we store the fields and notify the site
 * owner in chat. That turns a brochure site into a real lead-capture tool without
 * any per-customer backend.
 */

export interface Submission {
  id: string;
  siteId: string;
  formName: string | null;
  data: Record<string, string>;
  createdAt: string;
}

interface Row {
  id: string;
  site_id: string;
  form_name: string | null;
  data: Record<string, string>;
  created_at: string | Date;
}

const map = (r: Row): Submission => ({
  id: r.id,
  siteId: r.site_id,
  formName: r.form_name,
  data: r.data ?? {},
  createdAt: String(r.created_at),
});

export async function saveSubmission(args: {
  siteId: string;
  formName?: string | null;
  data: Record<string, string>;
  ip?: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO form_submissions (site_id, form_name, data, ip)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [args.siteId, args.formName ?? null, JSON.stringify(args.data), args.ip ?? null],
  );
}

/** Recent submissions for one site (customer-facing "my leads"). */
export async function submissionsForSite(siteId: string, limit = 20): Promise<Submission[]> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `SELECT * FROM form_submissions WHERE site_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [siteId, limit],
  );
  return rows.map(map);
}

/** Recent submissions across all sites (admin control centre). */
export async function recentSubmissions(limit = 100): Promise<Submission[]> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `SELECT * FROM form_submissions ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(map);
}

export async function countSubmissions(siteId?: string): Promise<number> {
  const db = await getDb();
  const rows = siteId
    ? await db.query<{ n: string }>(`SELECT count(*) AS n FROM form_submissions WHERE site_id = $1`, [siteId])
    : await db.query<{ n: string }>(`SELECT count(*) AS n FROM form_submissions`);
  return Number(rows[0]?.n ?? 0);
}
