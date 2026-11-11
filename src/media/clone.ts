import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { logger } from "../lib/logger.js";
import { assertSafeUrl, safeFetch } from "./webref.js";
import { canonRoute, fileOf, PRIORITY_ROUTE } from "../sites/routes.js";

const log = logger.child({ mod: "clone" });

/**
 * High-fidelity website cloning.
 *
 * Unlike the blueprint approach (which summarises a site and asks Forge to
 * REBUILD it from that sketch — inherently ~60% faithful), this RENDERS the real
 * page in a headless browser and copies its actual HTML, CSS and images, then
 * rehosts a cleaned, self-contained single file. That reproduces the genuine
 * content and genuine images, so fidelity is ~90%+.
 *
 * Safety: only the customer's OWN site should be cloned this way (the ownership
 * gate decides). Every URL we fetch — the page, its stylesheets and its images —
 * is SSRF-validated. All scripts are stripped, so none of the origin's JS
 * (trackers, or anything malicious) ends up in the rehosted copy.
 */

const NAV_TIMEOUT = 45_000;
const PER_IMAGE_CAP = 900 * 1024; // don't inline an image bigger than this
const INLINE_BUDGET = 11 * 1024 * 1024; // total data-URI budget (host file caps)
const CSS_CAP = 3 * 1024 * 1024;
const ASSET_FETCH_TIMEOUT = 12_000; // per asset — one slow file can't hang us
const ASSET_DEADLINE = 90_000; // overall asset-inlining budget; rest are hotlinked
const ASSET_CONCURRENCY = 6; // parallel downloads (huge win on slow links)

// Multi-page crawl bounds. A clone follows the site's own internal links so a
// real site (home + login + register + about …) is copied whole — capped so a
// huge site can't spin forever, and each sub-page gets a tighter inline budget.
const MAX_CLONE_PAGES = 10;
const SUBPAGE_INLINE_BUDGET = 6 * 1024 * 1024;
const SUBPAGE_ASSET_DEADLINE = 25_000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 ZurumBot/1.0";

/** Launch a hardened headless Chromium, closed when the signal aborts. */
async function launchBrowser(signal?: AbortSignal): Promise<Browser> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  if (signal) signal.addEventListener("abort", () => void browser.close().catch(() => {}));
  return browser;
}

/**
 * Render ONE page in an existing browser context and return its cleaned HTML,
 * final URL, and the same-origin links found on it (for the multi-page crawl).
 * Reusing the context across pages is what makes cloning a whole site fast.
 */
async function renderPage(
  context: BrowserContext,
  url: string,
  signal?: AbortSignal,
): Promise<{ html: string; baseUrl: string; links: string[] }> {
  await assertSafeUrl(url); // SSRF pre-check on every page we visit
  const page = await context.newPage();
  try {
    // Wait for the DOM to parse (fast + reliable) rather than "networkidle" —
    // real sites with analytics/chat widgets NEVER go idle, so networkidle just
    // times out. If even this times out, proceed and capture whatever rendered.
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    } catch (err) {
      log.warn({ url, err: (err as Error).message }, "goto slow — capturing partial render");
    }
    await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
    await autoScroll(page); // trigger lazy-loaded images
    await page.waitForTimeout(1200);

    // In the DOM (reliable): drop scripts, neutralise inline JS, promote lazy
    // images, absolutise asset URLs and canonicalise internal links. Passed as a
    // STRING (not a function) so the tsx/esbuild build helper isn't injected.
    await page.evaluate(CLEAN_DOM_JS);
    const links = (await page.evaluate(LINKS_JS).catch(() => [])) as string[];

    const baseUrl = page.url();
    const html = await page.content();
    return { html, baseUrl, links: Array.isArray(links) ? links : [] };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Render a single URL end-to-end (own browser). Used by the single-page path. */
async function render(url: string, signal?: AbortSignal): Promise<{ html: string; baseUrl: string }> {
  const browser = await launchBrowser(signal);
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: UA,
      javaScriptEnabled: true,
    });
    return await renderPage(context, url, signal);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Scroll the page in steps so lazy/on-view images actually load before capture. */
async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(AUTOSCROLL_JS).catch(() => {});
}

// ── Browser-context scripts (strings, not functions — see page.evaluate note) ──

const CLEAN_DOM_JS = `(() => {
  const abs = (u) => { if (!u) return ""; try { return new URL(u, location.href).href; } catch { return u; } };
  const largest = (ss) => { if (!ss) return ""; const p = ss.split(",").pop(); return p ? p.trim().split(/\\s+/)[0] : ""; };
  document.querySelectorAll("script, noscript").forEach((n) => n.remove());
  document.querySelectorAll("*").forEach((el) => {
    el.getAttributeNames().forEach((name) => { if (name.indexOf("on") === 0) el.removeAttribute(name); });
  });
  document.querySelectorAll("img").forEach((img) => {
    const lazy = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original");
    const cur = img.getAttribute("src");
    if (lazy && (!cur || cur.indexOf("data:") === 0)) img.setAttribute("src", lazy);
    const src = img.getAttribute("src");
    if (src) img.setAttribute("src", abs(src));
    else { const best = largest(img.getAttribute("srcset")); if (best) img.setAttribute("src", abs(best)); }
    img.removeAttribute("srcset"); img.removeAttribute("loading");
  });
  document.querySelectorAll("link[href]").forEach((l) => l.setAttribute("href", abs(l.getAttribute("href"))));
  var canon = (pathname) => {
    var p = pathname || "/";
    p = p.replace(/\\/index\\.(html?|php|aspx?)$/i, "/").replace(/\\.(html?|php|aspx?)$/i, "").replace(/\\/+$/g, "");
    return p === "" ? "/" : p;
  };
  document.querySelectorAll("a[href]").forEach((a) => {
    var raw = a.getAttribute("href");
    if (!raw || raw.charAt(0) === "#" || /^(mailto:|tel:|sms:|javascript:|data:|wa\.me)/i.test(raw)) return;
    try {
      var u = new URL(raw, location.href);
      if (u.origin === location.origin) {
        // Internal link to the ORIGINAL site — rewrite to a canonical, relative
        // ROUTE so it (a) never navigates back to the original, and (b) matches
        // the path the cloned sub-page is rehosted at (/login, /register, …).
        a.setAttribute("href", canon(u.pathname) + u.hash);
      } else {
        a.setAttribute("href", u.href); // keep genuine external links
      }
    } catch (e) { /* leave as-is */ }
  });
  document.querySelectorAll("source[srcset]").forEach((s) => { const best = largest(s.getAttribute("srcset")); if (best) s.setAttribute("srcset", abs(best)); });
  document.querySelectorAll("[style]").forEach((el) => {
    const s = el.getAttribute("style");
    if (s && s.indexOf("url(") !== -1) el.setAttribute("style", s.replace(/url\\(\\s*['"]?([^'")]+)['"]?\\s*\\)/g, (m, u) => 'url("' + abs(u) + '")'));
  });
})()`;

const AUTOSCROLL_JS = `(async () => {
  await new Promise((resolve) => {
    let y = 0; const step = 600;
    const timer = setInterval(() => {
      window.scrollBy(0, step); y += step;
      if (y >= document.body.scrollHeight - window.innerHeight) { clearInterval(timer); window.scrollTo(0, 0); resolve(); }
    }, 120);
    setTimeout(() => { clearInterval(timer); resolve(); }, 8000);
  });
})()`;

// Collect same-origin page pathnames (for the multi-page crawl). Skips asset
// files, anchors and non-navigational schemes — Node canonicalises each into a
// route. Returned as an array of raw pathnames.
const LINKS_JS = `(() => {
  var out = {};
  var links = document.querySelectorAll("a[href]");
  for (var i = 0; i < links.length; i++) {
    var raw = links[i].getAttribute("href");
    if (!raw || raw.charAt(0) === "#" || /^(mailto:|tel:|sms:|javascript:|data:|wa\.me)/i.test(raw)) continue;
    try {
      var u = new URL(raw, location.href);
      if (u.origin !== location.origin) continue;
      if (/\\.(png|jpe?g|gif|webp|svg|ico|bmp|pdf|zip|rar|gz|mp4|mp3|mov|avi|css|js|json|xml|txt|woff2?|ttf|otf|eot)$/i.test(u.pathname)) continue;
      out[u.pathname] = true;
    } catch (e) { /* skip */ }
  }
  return Object.keys(out);
})()`;

/** Download an asset and, if it's within budget + a real image, return a data URI. */
async function toDataUri(
  url: string,
  budget: { used: number },
  signal: AbortSignal,
  maxBytes: number,
): Promise<string | null> {
  if (budget.used >= maxBytes) return null;
  try {
    await assertSafeUrl(url);
    // Bound each asset fetch so one slow file can't stall the whole clone.
    const timed = AbortSignal.any([signal, AbortSignal.timeout(ASSET_FETCH_TIMEOUT)]);
    const res = await safeFetch(url, timed);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > PER_IMAGE_CAP || budget.used + buf.length > maxBytes) return null;
    const mime = imageMime(buf) ?? contentTypeMime(res.headers.get("content-type"));
    if (!mime) return null;
    budget.used += buf.length;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Trust the bytes, not the extension: identify images by their magic number. */
function imageMime(buf: Buffer): string | null {
  if (buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buf.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (buf.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
  if (
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (buf.subarray(0, 5).toString("ascii") === "<?xml" || buf.subarray(0, 4).toString("ascii") === "<svg")
    return "image/svg+xml";
  return null;
}

function contentTypeMime(ct: string | null): string | null {
  if (!ct) return null;
  const m = ct.split(";")[0]!.trim().toLowerCase();
  return /^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(m) ? m : null;
}

/** Replace external stylesheets with inline <style> (their url()s absolutised). */
async function inlineStylesheets(
  html: string,
  signal: AbortSignal,
): Promise<string> {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].filter((m) =>
    /rel=["']?stylesheet["']?/i.test(m[0]),
  );
  let out = html;
  for (const m of links) {
    const href = /href=["']([^"']+)["']/i.exec(m[0])?.[1];
    if (!href || !/^https?:/i.test(href)) continue;
    try {
      await assertSafeUrl(href);
      const timed = AbortSignal.any([signal, AbortSignal.timeout(ASSET_FETCH_TIMEOUT)]);
      const res = await safeFetch(href, timed);
      if (!res.ok) continue;
      let css = (await res.text()).slice(0, CSS_CAP);
      css = absolutiseCss(css, href);
      out = out.replace(m[0], `<style>${css}</style>`);
    } catch {
      /* leave the <link> as-is (hotlink) on failure */
    }
  }
  return out;
}

/** Resolve relative url(...) and @import in a stylesheet against its own URL. */
function absolutiseCss(css: string, sheetUrl: string): string {
  return css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (_m, u: string) => {
    if (/^(data:|https?:)/i.test(u)) return `url("${u}")`;
    try {
      return `url("${new URL(u, sheetUrl).href}")`;
    } catch {
      return `url("${u}")`;
    }
  });
}

/** Inline <img src> and CSS url() images as data URIs, within the byte budget. */
async function inlineImages(
  html: string,
  signal: AbortSignal,
  budget: { used: number },
  opts: { maxBytes?: number; deadlineMs?: number } = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? INLINE_BUDGET;
  const deadlineMs = opts.deadlineMs ?? ASSET_DEADLINE;
  // Collect unique absolute image URLs from <img src> and url(...) in styles.
  const urls = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*\bsrc=["'](https?:[^"']+)["']/gi)) urls.add(m[1]!);
  for (const m of html.matchAll(/url\(\s*["']?(https?:[^"')]+)["']?\s*\)/gi)) urls.add(m[1]!);

  const list = [...urls].filter((u) => !/\.(css|js|woff2?|ttf|otf|eot)(\?|$)/i.test(u));
  const map = new Map<string, string>();
  const deadline = Date.now() + deadlineMs;
  let next = 0;
  // Download in parallel with a hard deadline — on a slow link this is the
  // difference between minutes and seconds. Anything not fetched stays a hotlink
  // to the original, so the site is never broken, just less self-contained.
  const worker = async (): Promise<void> => {
    while (next < list.length && Date.now() < deadline && budget.used < maxBytes) {
      const u = list[next++]!;
      const data = await toDataUri(u, budget, signal, maxBytes);
      if (data) map.set(u, data);
    }
  };
  await Promise.all(Array.from({ length: ASSET_CONCURRENCY }, worker));

  let out = html;
  for (const [u, data] of map) {
    out = out.split(u).join(data); // replace every occurrence (src + css url)
  }
  log.info({ inlined: map.size, bytes: budget.used }, "clone: images inlined");
  return out;
}

/** Guess a web-font MIME from its URL extension (then its content-type). */
function fontMime(url: string, ct: string | null): string | null {
  const u = url.toLowerCase();
  if (u.includes(".woff2")) return "font/woff2";
  if (u.includes(".woff")) return "font/woff";
  if (u.includes(".ttf")) return "font/ttf";
  if (u.includes(".otf")) return "font/otf";
  if (u.includes(".eot")) return "application/vnd.ms-fontobject";
  const m = (ct ?? "").split(";")[0]!.trim().toLowerCase();
  return /^(font\/|application\/(x-font-|font-|vnd\.ms-fontobject))/.test(m) ? m : null;
}

/**
 * Inline @font-face fonts referenced in CSS as data URIs, so a clone carries its
 * own fonts and holds ZERO references back to the original domain (icon fonts
 * like Bootstrap glyphicons are the usual last hotlink). Anything over budget
 * stays a hotlink — the site still renders, just less self-contained.
 */
async function inlineFonts(
  html: string,
  signal: AbortSignal,
  opts: { maxBytes?: number; deadlineMs?: number } = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? 3 * 1024 * 1024;
  const deadlineMs = opts.deadlineMs ?? 30_000;
  const urls = new Set<string>();
  const re = /url\(\s*["']?(https?:\/\/[^"')]+?\.(?:woff2?|ttf|otf|eot)(?:[?#][^"')]*)?)["']?\s*\)/gi;
  for (const m of html.matchAll(re)) urls.add(m[1]!);
  if (!urls.size) return html;

  const list = [...urls];
  const budget = { used: 0 };
  const map = new Map<string, string>();
  const deadline = Date.now() + deadlineMs;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < list.length && Date.now() < deadline && budget.used < maxBytes) {
      const u = list[next++]!;
      try {
        await assertSafeUrl(u);
        const timed = AbortSignal.any([signal, AbortSignal.timeout(ASSET_FETCH_TIMEOUT)]);
        const res = await safeFetch(u, timed);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (budget.used + buf.length > maxBytes) continue;
        const mime = fontMime(u, res.headers.get("content-type"));
        if (!mime) continue;
        budget.used += buf.length;
        map.set(u, `data:${mime};base64,${buf.toString("base64")}`);
      } catch {
        /* leave as a hotlink on failure */
      }
    }
  };
  await Promise.all(Array.from({ length: ASSET_CONCURRENCY }, worker));

  let out = html;
  for (const [u, data] of map) out = out.split(u).join(data);
  log.info({ inlined: map.size, bytes: budget.used }, "clone: fonts inlined");
  return out;
}

/** Make sure the document has a doctype + charset + responsive viewport meta. */
function ensureHead(html: string): string {
  let out = html;
  if (!/^\s*<!doctype/i.test(out)) out = "<!DOCTYPE html>\n" + out;
  if (!/<meta[^>]+charset/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}<meta charset="utf-8">`);
  }
  if (!/name=["']viewport["']/i.test(out)) {
    out = out.replace(
      /<head[^>]*>/i,
      (m) => `${m}<meta name="viewport" content="width=device-width,initial-scale=1">`,
    );
  }
  return out;
}

/**
 * Clone a website into a cleaned, self-contained single HTML document.
 * Throws if the page can't be rendered (caller falls back to the blueprint path).
 */
export async function captureSite(url: string, signal?: AbortSignal): Promise<string> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const started = Date.now();
    const { html } = await render(url, signal);
    // If the render came back essentially empty (blocked, or a slow load that
    // never produced content), don't rehost a blank page — throw so the caller
    // falls back to the blueprint rebuild.
    const visible = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, "").trim();
    if (html.length < 1000 || visible.length < 120) {
      throw new Error("clone produced an empty/near-empty page");
    }
    let out = html;
    out = await inlineStylesheets(out, ac.signal);
    const budget = { used: 0 };
    out = await inlineImages(out, ac.signal, budget);
    out = await inlineFonts(out, ac.signal); // remove the last hotlinks to origin
    out = ensureHead(out);
    log.info(
      { url, bytes: out.length, inlinedBytes: budget.used, ms: Date.now() - started },
      "clone: captured",
    );
    return out;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * High-fidelity clone of a WHOLE site: crawls the source's own internal links
 * (home → login → register → about …) up to a page cap and rehosts each page as
 * its own self-contained file. Internal links are canonical routes, so the
 * rehosted pages navigate between each other on the customer's domain and never
 * back to the original.
 *
 * Returns a manifest map ("/index.html" → HTML, "/login/index.html" → HTML …).
 * Always contains at least the homepage; throws only if even that can't render
 * (caller then falls back to the single-page or blueprint path).
 */
export async function captureFullSite(
  url: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort);
  let browser: Browser | null = await launchBrowser(signal);
  try {
    const started = Date.now();
    const origin = new URL(url).origin;
    const entryRoute = canonRoute(new URL(url).pathname);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: UA,
      javaScriptEnabled: true,
    });

    // ── BFS crawl of same-origin pages ──
    const visited = new Set<string>();
    const raw = new Map<string, string>(); // manifest file path → raw html
    const queue: Array<{ route: string; url: string }> = [{ route: entryRoute, url }];
    while (queue.length && raw.size < MAX_CLONE_PAGES) {
      const item = queue.shift()!;
      if (visited.has(item.route)) continue;
      visited.add(item.route);

      let page: { html: string; links: string[] };
      try {
        page = await renderPage(context, item.url, ac.signal);
      } catch (err) {
        log.warn({ url: item.url, err: (err as Error).message }, "clone: page skipped");
        continue;
      }

      const visible = page.html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replace(/<[^>]+>/g, "")
        .trim();
      const empty = page.html.length < 800 || visible.length < 80;
      if (empty) {
        // The entry page MUST render; a blank sub-page is just dropped.
        if (item.route === entryRoute && raw.size === 0) {
          throw new Error("clone produced an empty/near-empty page");
        }
        continue;
      }

      if (item.route === entryRoute) {
        raw.set("/index.html", page.html); // entry is always the homepage
        if (entryRoute !== "/") raw.set(fileOf(entryRoute), page.html);
      } else {
        raw.set(fileOf(item.route), page.html);
      }

      // Enqueue freshly-discovered internal routes — important pages first so
      // the cap never sacrifices login/register/checkout for a blog archive.
      for (const pathname of page.links) {
        const route = canonRoute(pathname);
        if (visited.has(route) || queue.some((q) => q.route === route)) continue;
        const next = { route, url: origin + (route === "/" ? "/" : route) };
        if (PRIORITY_ROUTE.test(route)) queue.unshift(next);
        else queue.push(next);
      }
    }

    await browser.close().catch(() => {});
    browser = null; // rendering done — the rest is plain HTTP asset fetching

    // ── Make each captured page self-contained (inline CSS + images) ──
    const out = new Map<string, string>();
    let homepage = true;
    for (const [path, html] of raw) {
      let h = await inlineStylesheets(html, ac.signal);
      const budget = { used: 0 };
      // Homepage gets the full inline budget; sub-pages a tighter one so a large
      // site stays within host file limits and finishes promptly.
      h = await inlineImages(
        h,
        ac.signal,
        budget,
        homepage ? {} : { maxBytes: SUBPAGE_INLINE_BUDGET, deadlineMs: SUBPAGE_ASSET_DEADLINE },
      );
      h = await inlineFonts(h, ac.signal, homepage ? {} : { deadlineMs: SUBPAGE_ASSET_DEADLINE });
      out.set(path, ensureHead(h));
      homepage = false;
    }
    log.info(
      { url, pages: out.size, ms: Date.now() - started },
      "clone: captured full site",
    );
    return out;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await browser?.close().catch(() => {});
  }
}
