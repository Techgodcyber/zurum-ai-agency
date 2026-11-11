import { readSite, saveSite } from "./store.js";
import { getHosting } from "../launch/hosting-store.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "site-resolve" });

/**
 * Get a site's current HTML, resilient to a missing local copy. The deployed
 * site (Cloudflare/Netlify) is the real source of truth for what the customer
 * sees — so if the local file was lost (data reset, etc.), we FETCH the live
 * page and restore it locally. This is what makes edits keep working instead of
 * failing with "current site not found" while the site is clearly live.
 */
/**
 * True when a siteId points at a site that REALLY exists — either a local source
 * file or a live deployment. A conversation can end up holding a dead siteId (a
 * build that failed after the id was assigned), which silently breaks edits and
 * makes the bot claim "you have no site". Callers use this to detect and heal it.
 */
export async function siteExists(siteId: string): Promise<boolean> {
  if (await readSite(siteId)) return true;
  return Boolean((await getHosting(siteId))?.publicUrl);
}

export async function resolveSiteHtml(siteId: string): Promise<string | null> {
  const local = await readSite(siteId);
  if (local) return local;

  const hosting = await getHosting(siteId);
  if (!hosting?.publicUrl) return null;
  // A suspended site serves a takedown notice at its URL — never recover THAT as
  // if it were the customer's content (it would overwrite the real site).
  if (hosting.suspended) return null;
  try {
    const res = await fetch(hosting.publicUrl, {
      redirect: "follow",
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (html && html.length > 200 && /<\/html>/i.test(html)) {
      await saveSite(siteId, html); // restore the local copy for next time
      log.info({ siteId, url: hosting.publicUrl }, "recovered site HTML from live URL");
      return html;
    }
  } catch (err) {
    log.warn({ err, siteId }, "failed to recover site HTML from live URL");
  }
  return null;
}
