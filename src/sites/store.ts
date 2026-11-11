import { mkdir, readFile, writeFile, readdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * On-disk store for generated sites. Each site is a directory named by job id.
 * A single-page site holds just index.html; a CLONED multi-page site also holds
 * sub-pages (e.g. login/index.html, register/index.html). In production this is
 * replaced by object storage (Cloudflare R2) + deploy; locally it's just the
 * filesystem so previews work immediately.
 */
const SITES_DIR = join(process.cwd(), ".data", "sites");

function siteDir(jobId: string): string {
  return join(SITES_DIR, jobId);
}

export function sitePath(jobId: string): string {
  return join(siteDir(jobId), "index.html");
}

export async function saveSite(jobId: string, html: string): Promise<void> {
  const path = sitePath(jobId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html, "utf8");
}

export async function readSite(jobId: string): Promise<string | null> {
  const path = sitePath(jobId);
  if (!existsSync(path)) return null;
  return readFile(path, "utf8");
}

/**
 * Save a multi-page site: a map of manifest paths ("/index.html",
 * "/login/index.html", …) → HTML. Used by the high-fidelity clone when the
 * source site has more than one page.
 */
export async function saveSiteFiles(
  jobId: string,
  files: Map<string, string>,
): Promise<void> {
  for (const [p, html] of files) {
    // path.join normalises the POSIX-style manifest key to the OS separator.
    const full = join(siteDir(jobId), p.replace(/^\/+/, ""));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, html, "utf8");
  }
}

/**
 * Read every page of a site as a manifest map ("/index.html" → HTML). Returns
 * null if the site directory doesn't exist. A single-page site yields a map with
 * one entry, so callers can treat single- and multi-page sites uniformly.
 */
export async function readSiteFiles(jobId: string): Promise<Map<string, string> | null> {
  const dir = siteDir(jobId);
  if (!existsSync(dir)) return null;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const out = new Map<string, string>();
  for (const e of entries) {
    if (!e.isFile() || !/\.html?$/i.test(e.name)) continue;
    // Build the manifest key relative to the site dir, POSIX-style.
    const parent = (e.parentPath ?? (e as unknown as { path: string }).path ?? dir)
      .slice(dir.length)
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    const key = "/" + (parent ? `${parent}/${e.name}` : e.name);
    out.set(key, await readFile(join(dir, parent, e.name), "utf8"));
  }
  return out.size ? out : null;
}

/**
 * Publish a verified working copy to the stable site id (updates the live URL).
 * Copies the WHOLE directory as an overlay — so editing a multi-page site (whose
 * working copy holds only the changed index.html) never deletes the untouched
 * sub-pages already at the stable id.
 */
export async function copySite(fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const from = siteDir(fromId);
  if (!existsSync(from)) throw new Error(`copySite: source ${fromId} not found`);
  await mkdir(siteDir(toId), { recursive: true });
  await cp(from, siteDir(toId), { recursive: true, force: true });
}
