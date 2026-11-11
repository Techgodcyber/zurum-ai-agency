import { getDb } from "../db/index.js";
import { env } from "./env.js";

/**
 * Runtime-tunable settings — the in-chat "control center". These override the
 * env defaults for limits + pricing so the founder can change them live (via the
 * admin /set command) without editing files or restarting. Values are cached in
 * memory (single process) and refreshed on every change.
 */

// The tunable knobs and their env-backed defaults, with a one-line label.
const DEFS = {
  free_edit_limit: { def: () => env.FREE_EDIT_LIMIT, label: "free edits per customer" },
  free_build_limit: { def: () => env.FREE_BUILD_LIMIT, label: "free websites per customer (0 = off)" },
  edit_cost_credits: { def: () => env.EDIT_COST_CREDITS, label: "credits per edit" },
  build_cost_credits: { def: () => env.BUILD_COST_CREDITS, label: "credits per extra website" },
  credits_per_usd: { def: () => env.CREDITS_PER_USD, label: "credits per $1 on top-up" },
  min_topup_usd: { def: () => env.MIN_TOPUP_USD, label: "minimum top-up ($)" },
  low_credit_percent: { def: () => env.LOW_CREDIT_PERCENT, label: "warn to top up at this % of last top-up left" },
  ngn_per_usd: { def: () => env.NGN_PER_USD, label: "USD→NGN rate for Nigerian top-ups" },
  publish_price_static_usd: { def: () => env.PUBLISH_PRICE_STATIC_USD, label: "annual publish fee — static site ($)" },
  publish_price_dynamic_usd: { def: () => env.PUBLISH_PRICE_DYNAMIC_USD, label: "annual publish fee — dashboard/dynamic ($)" },
  preview_expiry_hours: { def: () => env.PREVIEW_EXPIRY_HOURS, label: "unpaid preview expires after N hours (0 = never)" },
  domain_daily_max_count: { def: () => 10, label: "max domains registered per 24h (funded-account spend guard)" },
  domain_daily_max_usd: { def: () => 300, label: "max domain spend per 24h in $ (funded-account spend guard)" },
  // Zurum Personal (companion product) — tunable without a deploy.
  personal_free_daily_texts: { def: () => 30, label: "Zurum Personal — free chat messages per day" },
  personal_sub_price_usd: { def: () => 5, label: "Zurum Personal — monthly subscription ($)" },
  personal_free_voice_seconds: { def: () => 1800, label: "Zurum Personal — total free voice seconds (30 min)" },
  personal_voice_daily_seconds: { def: () => 300, label: "Zurum Personal — free voice seconds per day (drip)" },
  // Provisional — set for real once the TTS provider (and its per-minute cost) is chosen.
  personal_voice_credits_per_min: { def: () => 8, label: "Zurum Personal — credits charged per voice minute (beyond free)" },
} as const;

export type SettingKey = keyof typeof DEFS;
export const SETTING_KEYS = Object.keys(DEFS) as SettingKey[];

export function isSettingKey(k: string): k is SettingKey {
  return k in DEFS;
}

const cache = new Map<SettingKey, number>();

/** Load all overrides from the DB into the cache. Call once on boot. */
export async function loadSettings(): Promise<void> {
  const db = await getDb();
  const rows = await db.query<{ key: string; value: string }>(`SELECT key, value FROM settings`);
  cache.clear();
  for (const r of rows) {
    if (isSettingKey(r.key)) cache.set(r.key, Number(r.value));
  }
}

/** Current value: DB override if set, else the env default. */
export function getNum(key: SettingKey): number {
  return cache.has(key) ? cache.get(key)! : DEFS[key].def();
}

/** Persist a new value and update the cache (takes effect immediately). */
export async function setNum(key: SettingKey, value: number): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, String(value)],
  );
  cache.set(key, value);
}

export function labelOf(key: SettingKey): string {
  return DEFS[key].label;
}

/** All current settings, for the /config view. */
export function allSettings(): { key: SettingKey; value: number; label: string }[] {
  return SETTING_KEYS.map((key) => ({ key, value: getNum(key), label: labelOf(key) }));
}
