import { createHash } from "node:crypto";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { getHosting, saveHosting } from "./hosting-store.js";

/**
 * Cloudflare Pages deployer — real public hosting with FREE unlimited bandwidth
 * and a global CDN (the durable scale host; Netlify's free tier is the bootstrap).
 *
 * Uses the Pages Direct Upload REST flow (what wrangler does under the hood):
 * create project → get an upload JWT → tell Cloudflare which asset hashes it's
 * missing (blake3 of base64+ext, the wrangler scheme) → upload them → create a
 * production deployment from a manifest. The same project is reused across edits,
 * so the customer's URL (`<project>.pages.dev`) never changes.
 */

const log = logger.child({ mod: "cloudflare" });
const API = "https://api.cloudflare.com/client/v4";

export function isCloudflareConfigured(): boolean {
  return Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID);
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface CfResult<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
}

/** Cloudflare API call authed with the account token. */
async function cf<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs = 45000,
): Promise<CfResult<T>> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    signal: withTimeout(signal, timeoutMs),
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(init.headers ?? {}) },
  });
  const json = (await res.json().catch(() => ({ success: false }))) as CfResult<T>;
  if (!res.ok || !json.success) {
    const detail = json.errors?.map((e) => `${e.code}:${e.message}`).join("; ") ?? res.status;
    throw new Error(`cloudflare ${init.method ?? "GET"} ${path} → ${detail}`);
  }
  return json;
}

/** A valid Cloudflare Pages project name (lowercase, alphanumeric + hyphens). */
function slugFromHtml(html: string): string {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug ? `zurum-${slug}` : "zurum-site";
}

function rand(n = 4): string {
  return Math.random().toString(36).slice(2, 2 + n);
}

interface Project {
  name: string;
  subdomain: string;
}

/** Create a Pages project, retrying with a random suffix if the name is taken. */
async function createProject(html: string, signal?: AbortSignal): Promise<Project> {
  const acct = env.CLOUDFLARE_ACCOUNT_ID;
  const base = slugFromHtml(html);
  // Cloudflare rejects names that are taken, too long, or occasionally fails with
  // a transient internal error — so try progressively simpler/unique names and
  // only give up (rethrowing the real reason) after the LAST candidate.
  const candidates = [base.slice(0, 54), `${base.slice(0, 48)}-${rand()}`, `zurum-${rand(8)}`];
  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const name = candidates[i]!;
    try {
      const { result } = await cf<{ subdomain: string }>(
        `/accounts/${acct}/pages/projects`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, production_branch: "main" }),
        },
        signal,
      );
      return { name, subdomain: result.subdomain };
    } catch (err) {
      lastErr = err;
      log.warn({ name, attempt: i + 1, err: (err as Error).message }, "pages project create retry");
      if (i < candidates.length - 1) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("cloudflare: could not create a Pages project");
}

/** wrangler-compatible asset hash: blake3(base64Contents + ext) → 32 hex chars. */
function assetHash(base64: string, ext: string): string {
  return bytesToHex(blake3(Buffer.from(base64 + ext, "utf8"))).slice(0, 32);
}

/**
 * Deploy a set of files (manifest path → HTML) to a Pages project in one
 * deployment. A single-page site passes one entry; a cloned multi-page site
 * passes many ("/index.html", "/login/index.html", …). Cloudflare's manifest is
 * path→asset-hash, so multi-page is native — we just upload every hash it's
 * missing and reference them all in the manifest.
 */
async function deployFiles(
  projectName: string,
  files: Map<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const acct = env.CLOUDFLARE_ACCOUNT_ID;
  const manifest: Record<string, string> = {};
  const payloads = new Map<string, string>(); // hash → base64 content (deduped)
  for (const [path, html] of files) {
    const base64 = Buffer.from(html, "utf8").toString("base64");
    const hash = assetHash(base64, "html");
    manifest[path] = hash;
    payloads.set(hash, base64);
  }

  // A short-lived JWT authorises the asset check-missing / upload endpoints.
  const { result: tok } = await cf<{ jwt: string }>(
    `/accounts/${acct}/pages/projects/${projectName}/upload-token`,
    { method: "GET" },
    signal,
  );
  const jwtHeaders = { authorization: `Bearer ${tok.jwt}`, "content-type": "application/json" };

  const allHashes = [...payloads.keys()];
  const missing = await fetch(`${API}/pages/assets/check-missing`, {
    method: "POST",
    headers: jwtHeaders,
    body: JSON.stringify({ hashes: allHashes }),
    signal: withTimeout(signal, 30000),
  })
    .then((r) => r.json() as Promise<CfResult<string[]>>)
    .then((j) => j.result ?? allHashes);

  // Upload missing assets in size-bounded batches — a multi-page clone can carry
  // several MB per page, and one giant request risks a body-size limit/timeout.
  const UPLOAD_BATCH_BYTES = 18 * 1024 * 1024;
  let batch: string[] = [];
  let batchBytes = 0;
  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    const body = batch.map((hash) => ({
      key: hash,
      value: payloads.get(hash)!,
      metadata: { contentType: "text/html" },
      base64: true,
    }));
    const up = await fetch(`${API}/pages/assets/upload`, {
      method: "POST",
      headers: jwtHeaders,
      body: JSON.stringify(body),
      signal: withTimeout(signal, 60000),
    });
    if (!up.ok) throw new Error(`cloudflare asset upload → ${up.status}`);
    batch = [];
    batchBytes = 0;
  };
  for (const hash of missing) {
    const size = payloads.get(hash)?.length ?? 0;
    if (batch.length && batchBytes + size > UPLOAD_BATCH_BYTES) await flush();
    batch.push(hash);
    batchBytes += size;
  }
  await flush();

  // Create a PRODUCTION deployment (branch = production_branch) so it serves at
  // the stable <project>.pages.dev URL.
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  form.append("branch", "main");
  await cf(`/accounts/${acct}/pages/projects/${projectName}/deployments`, {
    method: "POST",
    body: form,
  }, signal, 60000);
}

/**
 * Cloudflare's production URL (<name>.pages.dev) takes ~15-25s to actually serve
 * a new deployment at the edge. Poll it until it serves the new content so we
 * only tell the customer "ready" once their edit is truly live (Netlify is near-
 * instant; this closes that gap). Returns when live, or gives up after ~45s.
 */
async function waitLive(url: string, html: string, signal?: AbortSignal): Promise<boolean> {
  const want = createHash("sha1").update(Buffer.from(html, "utf8")).digest("hex");
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "cache-control": "no-cache", pragma: "no-cache" },
        signal: withTimeout(signal, 15000),
      });
      if (res.ok) {
        const body = await res.text();
        if (createHash("sha1").update(Buffer.from(body, "utf8")).digest("hex") === want) return true;
      }
    } catch {
      /* keep polling */
    }
  }
  return false;
}

/**
 * Attach a custom domain to a Pages project. Cloudflare then auto-provisions SSL
 * once the customer points DNS at the project. Tolerates "already added" so it's
 * safe to call again (e.g. apex + www, or a retried connect).
 */
export async function addPagesCustomDomain(
  projectName: string,
  domain: string,
  signal?: AbortSignal,
): Promise<void> {
  const acct = env.CLOUDFLARE_ACCOUNT_ID;
  try {
    await cf(
      `/accounts/${acct}/pages/projects/${projectName}/domains`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: domain.toLowerCase() }),
      },
      signal,
    );
    log.info({ projectName, domain }, "cloudflare pages custom domain added");
  } catch (err) {
    // Idempotent: a domain already attached to the project is not an error.
    if (/already|exist|8000037|duplicate/i.test((err as Error).message)) return;
    throw err;
  }
}

/**
 * Publish a multi-page site (manifest map) to Cloudflare Pages, reusing the same
 * project across edits so the public URL never changes. The homepage
 * ("/index.html") anchors the project name + the live-check. Returns the URL.
 */
export async function publishFilesToCloudflare(
  zurumSiteId: string,
  files: Map<string, string>,
  signal?: AbortSignal,
): Promise<{ url: string }> {
  const indexHtml = files.get("/index.html") ?? [...files.values()][0] ?? "";
  const hosting = await getHosting(zurumSiteId);
  let projectName: string;
  let url: string;
  if (hosting && hosting.provider === "cloudflare") {
    projectName = hosting.providerSiteId;
    url = hosting.publicUrl;
  } else {
    const project = await createProject(indexHtml, signal);
    projectName = project.name;
    url = `https://${project.subdomain}`;
    await saveHosting(zurumSiteId, projectName, url, "cloudflare");
    log.info({ zurumSiteId, projectName, url }, "created cloudflare pages project");
  }
  await deployFiles(projectName, files, signal);
  // Don't return until the deployment is actually visible at the production URL.
  const live = await waitLive(url, indexHtml, signal);
  log.info({ zurumSiteId, url, pages: files.size, live }, "deployed to cloudflare pages");
  return { url };
}

/**
 * Publish a single HTML page to Cloudflare Pages (the single-page path). Thin
 * wrapper over the multi-file deploy.
 */
export function publishToCloudflare(
  zurumSiteId: string,
  html: string,
  signal?: AbortSignal,
): Promise<{ url: string }> {
  return publishFilesToCloudflare(zurumSiteId, new Map([["/index.html", html]]), signal);
}
