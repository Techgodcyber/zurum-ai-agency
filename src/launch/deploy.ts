import { getHosting, setSuspended } from "./hosting-store.js";
import { isNetlifyConfigured, publishToNetlify } from "./netlify.js";
import { isCloudflareConfigured, publishToCloudflare, publishFilesToCloudflare } from "./cloudflare.js";
import { readSite } from "../sites/store.js";
import { logger } from "../lib/logger.js";

/**
 * Host dispatcher. Sends each site to a real public host, preferring Cloudflare
 * Pages (free unlimited bandwidth) when configured, else Netlify. A site that's
 * already deployed stays on ITS host, so its URL never changes even after we add
 * a new provider.
 *
 * Also owns the PER-SITE KILL SWITCH: suspending replaces just that one site with
 * a takedown notice at its own URL, so an abuse report never forces a fleet-wide
 * action (blast-radius containment, ARCHITECTURE §4.7).
 */

const log = logger.child({ mod: "deploy" });

export function isHostConfigured(): boolean {
  return isCloudflareConfigured() || isNetlifyConfigured();
}

/** Human label for the boot log. */
export function hostLabel(): string {
  const hosts = [
    isCloudflareConfigured() ? "cloudflare pages" : null,
    isNetlifyConfigured() ? "netlify" : null,
  ].filter(Boolean);
  return hosts.length ? `${hosts.join(" + ")} (live public URLs)` : "local preview only";
}

/** Publish HTML for a site to whichever host it belongs on. */
async function publishHtml(
  siteId: string,
  html: string,
  signal?: AbortSignal,
): Promise<{ url: string }> {
  const hosting = await getHosting(siteId);
  // Keep an existing site on the host it already lives on; new sites go to the
  // preferred host (Cloudflare first).
  const provider =
    hosting?.provider ?? (isCloudflareConfigured() ? "cloudflare" : "netlify");
  return provider === "cloudflare"
    ? publishToCloudflare(siteId, html, signal)
    : publishToNetlify(siteId, html, signal);
}

export async function publishSite(
  siteId: string,
  html: string,
  signal?: AbortSignal,
): Promise<{ url: string }> {
  const hosting = await getHosting(siteId);
  if (hosting?.suspended) {
    throw new Error("site is suspended — restore it before publishing");
  }
  return publishHtml(siteId, html, signal);
}

/**
 * Publish a multi-page site (manifest map of path → HTML) to its host. Used for
 * cloned sites with sub-pages (login, register, …). Cloudflare Pages deploys the
 * whole set natively; the Netlify fallback publishes the homepage only (multi-
 * page there isn't wired yet), so a cloned site still has a working landing page.
 * A single-entry map is handled identically, so callers can always route through
 * here regardless of page count.
 */
export async function publishSiteFiles(
  siteId: string,
  files: Map<string, string>,
  signal?: AbortSignal,
): Promise<{ url: string }> {
  const hosting = await getHosting(siteId);
  if (hosting?.suspended) {
    throw new Error("site is suspended — restore it before publishing");
  }
  const provider =
    hosting?.provider ?? (isCloudflareConfigured() ? "cloudflare" : "netlify");
  if (provider === "cloudflare") {
    return publishFilesToCloudflare(siteId, files, signal);
  }
  const index = files.get("/index.html") ?? [...files.values()][0] ?? "";
  if (files.size > 1) {
    log.warn({ siteId, pages: files.size }, "multi-page site on netlify — publishing homepage only");
  }
  return publishToNetlify(siteId, index, signal);
}

/** The page served in place of a suspended site. */
function takedownPage(reason: string | null): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Site unavailable</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0}
.card{max-width:32rem;padding:2.5rem;text-align:center}
h1{font-size:1.5rem;margin:0 0 .75rem}
p{margin:0 0 .5rem;color:#94a3b8}
.r{margin-top:1rem;font-size:.875rem;color:#64748b}
</style></head><body><div class="card">
<h1>This site is temporarily unavailable</h1>
<p>It has been suspended by the hosting provider.</p>
${reason ? `<p class="r">Reason: ${reason.replace(/[<>&]/g, "")}</p>` : ""}
<p class="r">If you are the site owner, please contact support.</p>
</div></body></html>`;
}

/**
 * KILL SWITCH — take a single site offline. Replaces its content with a takedown
 * notice at the host, so the live URL stops serving the site immediately while
 * every other customer is untouched. The original HTML is kept locally so the
 * site can be restored intact.
 */
export async function suspendSite(
  siteId: string,
  reason: string | null,
): Promise<{ ok: boolean; url: string | null; error?: string }> {
  const hosting = await getHosting(siteId);
  await setSuspended(siteId, true, reason);
  if (!hosting) return { ok: true, url: null }; // never deployed — flag is enough
  try {
    await publishHtml(siteId, takedownPage(reason));
    log.warn({ siteId, reason }, "site suspended (kill switch)");
    return { ok: true, url: hosting.publicUrl };
  } catch (err) {
    log.error({ err, siteId }, "suspend: takedown publish failed");
    // Still suspended in our records (edits/publishes are blocked) even if the
    // host push failed — the operator can retry.
    return { ok: false, url: hosting.publicUrl, error: (err as Error).message };
  }
}

/** Restore a suspended site by republishing its real content. */
export async function restoreSite(
  siteId: string,
): Promise<{ ok: boolean; url: string | null; error?: string }> {
  await setSuspended(siteId, false, null);
  // Read the LOCAL copy only — the live URL is currently serving the takedown
  // notice, so recovering from it would overwrite the customer's real site.
  const html = await readSite(siteId);
  const hosting = await getHosting(siteId);
  if (!html) {
    return { ok: false, url: hosting?.publicUrl ?? null, error: "no saved content to restore" };
  }
  try {
    const { url } = await publishHtml(siteId, html);
    log.info({ siteId }, "site restored");
    return { ok: true, url };
  } catch (err) {
    log.error({ err, siteId }, "restore publish failed");
    return { ok: false, url: hosting?.publicUrl ?? null, error: (err as Error).message };
  }
}
