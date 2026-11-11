import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

/**
 * FX rates (exchangerate-api.com) so non-Nigerian customers are charged in their
 * own currency. Rates are cached in-memory for an hour (they barely move and the
 * free tier is rate-limited). Gated on FX_API_KEY — absent, only NGN + USD are
 * offered (NGN via the manual ngn_per_usd rate).
 */

const log = logger.child({ mod: "fx" });
const TTL_MS = 60 * 60 * 1000;

let cache: { rates: Record<string, number>; at: number } | null = null;

export function isFxConfigured(): boolean {
  return Boolean(env.FX_API_KEY);
}

async function rates(signal?: AbortSignal): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rates;
  const res = await fetch(`${env.FX_BASE_URL}/${env.FX_API_KEY}/latest/USD`, {
    signal: signal ?? AbortSignal.timeout(15000),
  });
  const json = (await res.json()) as {
    result?: string;
    conversion_rates?: Record<string, number>;
    ["error-type"]?: string;
  };
  if (json.result !== "success" || !json.conversion_rates) {
    throw new Error(`fx fetch failed: ${json["error-type"] ?? res.status}`);
  }
  cache = { rates: json.conversion_rates, at: Date.now() };
  return cache.rates;
}

/** USD→currency rate, or null if FX isn't configured / the fetch fails. */
export async function usdRate(currency: string, signal?: AbortSignal): Promise<number | null> {
  if (!isFxConfigured()) return null;
  try {
    return (await rates(signal))[currency] ?? null;
  } catch (err) {
    log.warn({ err, currency }, "fx rate fetch failed");
    return null;
  }
}
