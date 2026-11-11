import { callModel } from "../models/index.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "images" });

/**
 * Real stock photography (Pexels) for generated sites. Real photos are the single
 * biggest driver of a site looking rich vs. flat "AI slop". We derive a few search
 * phrases from the brief, fetch matching photos, and hand their URLs to Forge to
 * place. Absent a key, returns [] and Forge falls back to CSS visuals.
 */

export function isPexelsConfigured(): boolean {
  return Boolean(env.PEXELS_API_KEY);
}

export interface StockPhoto {
  url: string;
  alt: string;
  query: string;
}

/** Ask a fast model for stock-photo search phrases that suit the brief. */
export async function imageQueriesFor(brief: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await callModel("scribe", {
      system:
        "Given a website brief, output 6-8 short, SPECIFIC stock-photo search phrases (2-3 words " +
        "each) for photos that suit the site — its industry, products/services, people, and mood " +
        "(e.g. for a spa: 'spa massage', 'facial treatment', 'spa interior', 'hot stones', " +
        "'relaxed woman', 'essential oils'). Reply with ONLY the phrases, comma-separated, no " +
        "numbering, no other words.",
      messages: [{ role: "user", content: brief.slice(0, 1500) }],
      maxTokens: 80,
      thinking: false,
      jobId: "image-queries",
      signal,
    });
    return res.text
      .split(/[,\n]/)
      .map((q) => q.replace(/^[\d.\-•\s]+/, "").trim())
      .filter((q) => q.length > 1 && q.length < 40)
      .slice(0, 8);
  } catch (err) {
    log.warn({ err }, "image query generation failed");
    return [];
  }
}

interface PexelsResp {
  photos?: { src?: { large?: string; large2x?: string }; alt?: string }[];
}

async function pexelsSearch(
  query: string,
  perPage: number,
  signal?: AbortSignal,
): Promise<StockPhoto[]> {
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`,
      { headers: { authorization: env.PEXELS_API_KEY ?? "" }, signal: signal ?? AbortSignal.timeout(15000) },
    );
    if (!res.ok) {
      log.warn({ status: res.status, query }, "pexels search failed");
      return [];
    }
    const data = (await res.json()) as PexelsResp;
    return (data.photos ?? [])
      .map((p) => ({ url: p.src?.large2x ?? p.src?.large ?? "", alt: p.alt || query, query }))
      .filter((p) => p.url);
  } catch (err) {
    log.warn({ err, query }, "pexels fetch error");
    return [];
  }
}

/**
 * Build a palette of real photos for a brief. Returns [] when Pexels isn't
 * configured or nothing is found — Forge then falls back to CSS visuals.
 */
export async function imagePaletteFor(brief: string, signal?: AbortSignal): Promise<StockPhoto[]> {
  if (!isPexelsConfigured()) return [];
  const queries = await imageQueriesFor(brief, signal);
  if (!queries.length) return [];
  const out: StockPhoto[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    for (const photo of await pexelsSearch(q, 3, signal)) {
      if (!seen.has(photo.url)) {
        seen.add(photo.url);
        out.push(photo);
      }
    }
    if (out.length >= 18) break;
  }
  log.info({ count: out.length, queries: queries.length }, "image palette built");
  return out.slice(0, 18);
}
