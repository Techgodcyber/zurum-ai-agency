import { getDb } from "../db/index.js";

/**
 * Persistent mapping from a stable Zurum site id to the hosting provider's site
 * it was deployed to. Lets every edit redeploy to the SAME provider site, so the
 * customer's public URL never changes across changes (matches the stable-URL
 * promise the preview server already makes locally).
 */

export interface Hosting {
  siteId: string;
  provider: string;
  providerSiteId: string;
  publicUrl: string;
  suspended: boolean;
  suspendedReason: string | null;
}

interface Row {
  site_id: string;
  provider: string;
  provider_site_id: string;
  public_url: string;
  suspended: boolean | null;
  suspended_reason: string | null;
}

export async function getHosting(siteId: string): Promise<Hosting | null> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `SELECT * FROM site_hosting WHERE site_id = $1`,
    [siteId],
  );
  const r = rows[0];
  return r ? map(r) : null;
}

const map = (r: Row): Hosting => ({
  siteId: r.site_id,
  provider: r.provider,
  providerSiteId: r.provider_site_id,
  publicUrl: r.public_url,
  suspended: r.suspended ?? false,
  suspendedReason: r.suspended_reason,
});

/** Every hosted site, newest first — powers the admin control centre. */
export async function allHosting(limit = 200): Promise<Hosting[]> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `SELECT * FROM site_hosting ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(map);
}

/** Flag/unflag a site as suspended (the deploy layer performs the takedown). */
export async function setSuspended(
  siteId: string,
  suspended: boolean,
  reason: string | null,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE site_hosting
        SET suspended = $2, suspended_reason = $3,
            suspended_at = CASE WHEN $2 THEN now() ELSE NULL END,
            updated_at = now()
      WHERE site_id = $1`,
    [siteId, suspended, reason],
  );
}

export async function saveHosting(
  siteId: string,
  providerSiteId: string,
  publicUrl: string,
  provider = "netlify",
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO site_hosting (site_id, provider, provider_site_id, public_url, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (site_id) DO UPDATE
       SET provider = $2, provider_site_id = $3, public_url = $4, updated_at = now()`,
    [siteId, provider, providerSiteId, publicUrl],
  );
}
