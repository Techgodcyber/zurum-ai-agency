import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { getHosting, saveHosting } from "./hosting-store.js";

/**
 * Netlify deployer — turns a generated static site into a REAL public URL.
 *
 * Uses Netlify's file-digest deploy API (no zip/CLI dependency): create a site
 * once per Zurum site id, then for each publish send the sha1 of index.html;
 * Netlify replies which files it still needs, we PUT those bytes, and the deploy
 * goes live at `https://<name>.netlify.app`. Re-deploying identical content is a
 * no-op (content-addressed), so edits that change nothing cost nothing.
 *
 * The same Netlify site is reused across edits (via site_hosting) so the public
 * URL stays constant — edits update in place, exactly like the local preview.
 */

const log = logger.child({ mod: "netlify" });
const API = "https://api.netlify.com/api/v1";

export function isNetlifyConfigured(): boolean {
  return Boolean(env.NETLIFY_TOKEN);
}

/** Provided signal (job wall-clock) combined with a per-request timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function api(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs = 30000,
): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    signal: withTimeout(signal, timeoutMs),
    headers: {
      authorization: `Bearer ${env.NETLIFY_TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
}

async function apiJson<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const res = await api(
    path,
    { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } },
    signal,
  );
  if (!res.ok) {
    throw new Error(
      `netlify ${init.method ?? "GET"} ${path} → ${res.status}: ${await res
        .text()
        .catch(() => "")}`,
    );
  }
  return res.json() as Promise<T>;
}

interface NetlifySite {
  id: string;
  url: string;
  ssl_url?: string;
  name: string;
}
interface NetlifyDeploy {
  id: string;
  state: string;
  required?: string[];
}

/** A friendly, valid Netlify subdomain derived from the page title. */
function slugFromHtml(html: string): string {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug ? `zurum-${slug}` : "zurum-site";
}

function rand(n = 4): string {
  return Math.random().toString(36).slice(2, 2 + n);
}

/**
 * Create a Netlify site with a readable name; fall back through a couple of
 * random suffixes if the name is taken (422), then let Netlify auto-name.
 */
async function createSite(html: string, signal?: AbortSignal): Promise<NetlifySite> {
  const base = slugFromHtml(html);
  for (const name of [base, `${base}-${rand()}`, `${base}-${rand()}`]) {
    const res = await api(
      `/sites`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) },
      signal,
    );
    if (res.status === 422) {
      await res.text().catch(() => {}); // name taken — drain and try the next
      continue;
    }
    if (!res.ok) {
      throw new Error(`netlify create site → ${res.status}: ${await res.text().catch(() => "")}`);
    }
    return (await res.json()) as NetlifySite;
  }
  // All named attempts collided — let Netlify pick a unique auto name.
  return apiJson<NetlifySite>(`/sites`, { method: "POST", body: "{}" }, signal);
}

async function deployHtml(
  netlifySiteId: string,
  html: string,
  signal?: AbortSignal,
): Promise<void> {
  const buf = Buffer.from(html, "utf8");
  const sha = createHash("sha1").update(buf).digest("hex");

  const deploy = await apiJson<NetlifyDeploy>(
    `/sites/${netlifySiteId}/deploys`,
    { method: "POST", body: JSON.stringify({ files: { "/index.html": sha } }) },
    signal,
  );

  // Netlify tells us which digests it still needs; upload only those.
  if ((deploy.required ?? []).includes(sha)) {
    const res = await api(
      `/deploys/${deploy.id}/files/index.html`,
      { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: buf },
      signal,
      45000,
    );
    if (!res.ok) {
      throw new Error(`netlify upload → ${res.status}: ${await res.text().catch(() => "")}`);
    }
  }

  await waitForReady(deploy.id, signal);
}

async function waitForReady(deployId: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const d = await apiJson<NetlifyDeploy>(`/deploys/${deployId}`, { method: "GET" }, signal);
    if (d.state === "ready") return;
    if (d.state === "error") throw new Error("netlify deploy failed (state=error)");
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Non-fatal: Netlify usually finishes within seconds; the URL serves once done.
  log.warn({ deployId }, "netlify deploy still processing after 60s");
}

/**
 * Attach a customer-owned custom domain to their Netlify site. Netlify stores it
 * and auto-provisions SSL once the customer's DNS points here — so connecting a
 * domain someone already owns costs nothing and needs no registrar.
 */
export async function setCustomDomain(
  netlifySiteId: string,
  customDomain: string,
  aliases: string[],
  signal?: AbortSignal,
): Promise<void> {
  const res = await api(
    `/sites/${netlifySiteId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ custom_domain: customDomain, domain_aliases: aliases }),
    },
    signal,
  );
  if (!res.ok) {
    throw new Error(`netlify set domain → ${res.status}: ${await res.text().catch(() => "")}`);
  }
  log.info({ netlifySiteId, customDomain }, "custom domain attached");
}

/**
 * Publish a site's HTML to Netlify, reusing the same Netlify site across edits
 * so the public URL never changes. Returns the live URL.
 */
export async function publishToNetlify(
  zurumSiteId: string,
  html: string,
  signal?: AbortSignal,
): Promise<{ url: string }> {
  const existing = await getHosting(zurumSiteId);
  let providerSiteId: string;
  let url: string;
  if (existing) {
    providerSiteId = existing.providerSiteId;
    url = existing.publicUrl;
  } else {
    const site = await createSite(html, signal);
    url = site.ssl_url || site.url;
    providerSiteId = site.id;
    await saveHosting(zurumSiteId, site.id, url);
    log.info({ zurumSiteId, netlifySiteId: site.id, url }, "created netlify site");
  }
  await deployHtml(providerSiteId, html, signal);
  log.info({ zurumSiteId, url }, "deployed to netlify");
  return { url };
}
