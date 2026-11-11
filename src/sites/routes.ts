/**
 * Pure URL-route helpers shared by the cloner, the site store and the preview
 * server. Kept dependency-free (no playwright/fs) so any layer can import it.
 *
 * A multi-page clone stores each captured page as `<route>/index.html`, and the
 * cloned pages link to each other by their canonical ROUTE (e.g. `/login`), so a
 * clean-URL host (Cloudflare Pages) resolves them without extension juggling.
 */

/**
 * Reduce any same-origin pathname to a stable, extension-free route key.
 *   "/"                  → "/"
 *   "/login/"            → "/login"
 *   "/login.html"        → "/login"
 *   "/about.php"         → "/about"
 *   "/account/index.html"→ "/account"
 *   "/products/shirt"    → "/products/shirt"
 */
export function canonRoute(pathname: string): string {
  let p = pathname || "/";
  try {
    p = decodeURI(p);
  } catch {
    /* keep raw on malformed escapes */
  }
  p = p.replace(/\/index\.(html?|php|aspx?)$/i, "/"); // drop trailing index.*
  p = p.replace(/\.(html?|php|aspx?)$/i, ""); // drop page extension
  p = p.replace(/\/+$/g, ""); // strip trailing slashes
  return p === "" ? "/" : p;
}

/** The on-disk / manifest file path a route is served from. */
export function fileOf(route: string): string {
  const r = canonRoute(route);
  return r === "/" ? "/index.html" : `${r}/index.html`;
}

/** Pages worth crawling FIRST so the page cap never drops the important ones. */
export const PRIORITY_ROUTE =
  /(log[\s-]?in|sign[\s-]?in|sign[\s-]?up|register|account|dashboard|profile|checkout|cart|pric|plan|contact|about|service|product|shop|store|book|faq|feature|gallery|portfolio|menu)/i;
