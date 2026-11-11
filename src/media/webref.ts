import { lookup } from "node:dns/promises";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "webref" });

/**
 * SSRF guard. A customer-supplied URL must never let us reach internal
 * infrastructure — cloud metadata (169.254.169.254), localhost, or private LAN
 * ranges. We resolve the host and validate the IP before every connection, and
 * again on every redirect hop.
 */
export function isBlockedAddress(ip: string): boolean {
  // IPv6 loopback / link-local / unique-local
  if (ip === "::1" || ip === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true; // fe80::/10
  // IPv4 (incl. IPv4-mapped IPv6)
  const v4 = ip.replace(/^::ffff:/i, "");
  const parts = v4.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 127) return true; // this-host / loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** Validate scheme, port and resolved IP. Throws if the URL is unsafe. */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("only http(s) URLs are supported");
  }
  if (u.port && !["80", "443"].includes(u.port)) {
    throw new Error("blocked port");
  }
  const { address } = await lookup(u.hostname);
  if (isBlockedAddress(address)) {
    log.warn({ host: u.hostname, address }, "blocked SSRF attempt");
    throw new Error("that address is not allowed");
  }
  return u;
}

/** Fetch following redirects manually, re-validating every hop (max 3). */
export async function safeFetch(raw: string, signal: AbortSignal): Promise<Response> {
  let target = raw;
  for (let hop = 0; hop <= 3; hop++) {
    const url = await assertSafeUrl(target);
    const res = await fetch(url, {
      signal,
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (compatible; ZurumBot/1.0)" },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      target = new URL(location, url).toString(); // re-validated next loop
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

/**
 * A distilled "blueprint" of a reference website: enough for Forge to rebuild
 * the same structure and look, without shipping 200KB of raw HTML into the
 * prompt (which would be slow and expensive).
 */
export interface SiteBlueprint {
  url: string;
  title: string;
  description: string;
  nav: string[];
  headings: string[];
  colors: string[];
  fonts: string[];
  textSample: string;
}

const strip = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Most frequent values first, capped. */
function topValues(matches: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const m of matches) counts.set(m, (counts.get(m) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([v]) => v);
}

/** Fetch a public page and distil it into a rebuild blueprint. */
export async function fetchBlueprint(url: string): Promise<SiteBlueprint> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let html: string;
  try {
    const res = await safeFetch(url, controller.signal); // SSRF-validated
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(type)) {
      throw new Error("that link isn't a web page");
    }
    html = (await res.text()).slice(0, 600_000); // hard size cap
  } finally {
    clearTimeout(timer);
  }

  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? "";
  const description =
    html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    )?.[1] ?? "";

  // Nav labels (header/nav anchors).
  const navBlock = html.match(/<nav[\s\S]{0,4000}?<\/nav>/i)?.[0] ?? html.slice(0, 8000);
  const nav = [...navBlock.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => strip(m[1]!))
    .filter((t) => t && t.length < 30)
    .slice(0, 12);

  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((m) => strip(m[1]!))
    .filter((t) => t && t.length < 90)
    .slice(0, 20);

  const colors = topValues(
    [...html.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase()),
    8,
  );
  const fonts = topValues(
    [...html.matchAll(/font-family\s*:\s*([^;"'}]+)/gi)].map((m) =>
      m[1]!.trim().slice(0, 60),
    ),
    4,
  );

  const textSample = strip(html).slice(0, 1500);

  log.info({ url, headings: headings.length, colors: colors.length }, "blueprint extracted");
  return { url, title, description, nav, headings, colors, fonts, textSample };
}

/** Render the blueprint as a compact brief for Forge. */
export function blueprintToBrief(bp: SiteBlueprint, exact: boolean): string {
  const mode = exact
    ? "Rebuild this website as closely as you can — the customer OWNS this site and wants the same design recreated."
    : "Build a NEW site inspired by the structure and style below. Use it as a layout/style reference only — write original copy and do NOT copy their brand name, logo or wording.";
  return [
    mode,
    `Reference: ${bp.url}`,
    bp.title && `Title: ${bp.title}`,
    bp.description && `Description: ${bp.description}`,
    bp.nav.length && `Navigation: ${bp.nav.join(" | ")}`,
    bp.headings.length && `Headings/sections: ${bp.headings.join(" · ")}`,
    bp.colors.length && `Colour palette: ${bp.colors.join(", ")}`,
    bp.fonts.length && `Fonts: ${bp.fonts.join(" ; ")}`,
    bp.textSample && `Content sample: ${bp.textSample}`,
  ]
    .filter(Boolean)
    .join("\n");
}
