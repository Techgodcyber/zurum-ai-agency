import { getDb } from "../db/index.js";
import { env } from "../config/env.js";
import { getNum } from "../config/settings.js";

/**
 * Build metering. Each customer gets a free allowance of NEW websites; past it
 * they must upgrade. Without this, anyone can build unlimited sites on your dime
 * (each build costs real model + hosting money). Edits do NOT count — only new
 * sites. Admins and per-user overrides can lift the cap.
 *
 * The web dashboard (later) will drive the same build_quota table these helpers
 * read/write, so the control surface is forward-compatible.
 */

export interface QuotaState {
  allowed: boolean;
  used: number;
  /** The effective cap, or null when unlimited. */
  limit: number | null;
  unlimited: boolean;
}

// ── Pure helpers (unit-tested) ───────────────────────────

/** Parse a comma-separated identity list ("telegram:1,telegram:2") to a set. */
export function parseIdentities(csv?: string | null): Set<string> {
  return new Set(
    (csv ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Effective cap for a user given their override and the global default. */
export function effectiveLimit(
  buildLimit: number | null | undefined,
  globalDefault: number,
): number {
  if (buildLimit === -1) return Infinity; // explicit unlimited
  if (buildLimit == null) return globalDefault === 0 ? Infinity : globalDefault;
  return buildLimit;
}

export type AdminCommand =
  | { kind: "id" }
  | { kind: "balance" }
  | { kind: "config" }
  | { kind: "set"; key: string; value: number }
  | { kind: "quota"; target: string }
  | { kind: "limit"; target: string; value: "unlimited" | "default" | number }
  | { kind: "grant"; target: string; value: number }
  | null;

/** Parse an in-chat control command. Returns null if it isn't one. */
export function parseCommand(text: string): AdminCommand {
  const t = text.trim();
  if (/^\/id$/i.test(t)) return { kind: "id" };
  if (/^\/(credits|balance)$/i.test(t)) return { kind: "balance" };
  if (/^\/config$/i.test(t)) return { kind: "config" };
  const s = t.match(/^\/set\s+(\S+)\s+(\d+)$/i);
  if (s) return { kind: "set", key: s[1]!.toLowerCase(), value: Number(s[2]) };
  const q = t.match(/^\/quota\s+(\S+)$/i);
  if (q) return { kind: "quota", target: q[1]! };
  const g = t.match(/^\/grant\s+(\S+)\s+(\d+)$/i);
  if (g) return { kind: "grant", target: g[1]!, value: Number(g[2]) };
  const l = t.match(/^\/limit\s+(\S+)\s+(\S+)$/i);
  if (l) {
    const raw = l[2]!.toLowerCase();
    if (raw === "unlimited") return { kind: "limit", target: l[1]!, value: "unlimited" };
    if (raw === "default") return { kind: "limit", target: l[1]!, value: "default" };
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return { kind: "limit", target: l[1]!, value: n };
  }
  return null;
}

/** Split an identity string "telegram:12345" into its parts. */
export function splitIdentity(id: string): { channel: string; externalId: string } | null {
  const i = id.indexOf(":");
  if (i <= 0 || i === id.length - 1) return null;
  return { channel: id.slice(0, i).trim().toLowerCase(), externalId: id.slice(i + 1).trim() };
}

/** MEANING (voice layer) shown when a customer hits their free build limit. */
export function buildLimitReachedMeaning(used: number, limit: number | null): string {
  return `Warmly but clearly tell the customer they've reached their free website limit (they've built ${used} of ${limit} free sites). To build another they'll be able to upgrade to a paid plan very soon — invite them to reply if they'd like it now or want to be notified. Reassure them the website(s) they already built are safe, still live, and they can keep editing those anytime.`;
}

// ── Admin / exemption ────────────────────────────────────

let adminCache: Set<string> | null = null;
function adminSet(): Set<string> {
  if (!adminCache) adminCache = parseIdentities(env.ADMIN_IDENTITIES);
  return adminCache;
}

export function isAdminIdentity(channel: string, externalId: string): boolean {
  return adminSet().has(`${channel}:${externalId}`.toLowerCase());
}

// ── DB-backed quota ──────────────────────────────────────

interface Row {
  build_limit: number | null;
  builds_used: number | string;
  edits_used: number | string;
}

async function row(userId: string): Promise<Row> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `SELECT build_limit, builds_used, edits_used FROM build_quota WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? { build_limit: null, builds_used: 0, edits_used: 0 };
}

/** How many free edits this customer has already used. */
export async function editsUsed(userId: string): Promise<number> {
  return Number((await row(userId)).edits_used);
}

/** Free-tier usage counts (builds + edits) for the wallet card. */
export async function usageStats(userId: string): Promise<{ buildsUsed: number; editsUsed: number }> {
  const r = await row(userId);
  return { buildsUsed: Number(r.builds_used), editsUsed: Number(r.edits_used) };
}

/** Count a consumed free edit. */
export async function consumeFreeEdit(userId: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO build_quota (user_id, edits_used) VALUES ($1, 1)
     ON CONFLICT (user_id) DO UPDATE
       SET edits_used = build_quota.edits_used + 1, updated_at = now()`,
    [userId],
  );
}

/** Give back a free edit (a free edit failed). */
export async function refundFreeEdit(userId: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE build_quota SET edits_used = GREATEST(edits_used - 1, 0), updated_at = now()
     WHERE user_id = $1`,
    [userId],
  );
}

/** Whether this user may start a NEW build, plus their current usage. */
export async function checkBuild(
  userId: string,
  channel: string,
  externalId: string,
): Promise<QuotaState> {
  const r = await row(userId);
  const used = Number(r.builds_used);
  const globalFree = getNum("free_build_limit");
  // Master switch off, or an admin/trusted identity → unlimited.
  if (globalFree === 0 || isAdminIdentity(channel, externalId)) {
    return { allowed: true, used, limit: null, unlimited: true };
  }
  const limit = effectiveLimit(r.build_limit, globalFree);
  const unlimited = !Number.isFinite(limit);
  return {
    allowed: used < limit,
    used,
    limit: unlimited ? null : limit,
    unlimited,
  };
}

/** Count a consumed build (a new site). No-op semantics handled by caller. */
export async function consumeBuild(userId: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO build_quota (user_id, builds_used) VALUES ($1, 1)
     ON CONFLICT (user_id) DO UPDATE
       SET builds_used = build_quota.builds_used + 1, updated_at = now()`,
    [userId],
  );
}

/** Give back a build (e.g. the build job failed, so it shouldn't count). */
export async function refundBuild(userId: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE build_quota SET builds_used = GREATEST(builds_used - 1, 0), updated_at = now()
     WHERE user_id = $1`,
    [userId],
  );
}

/** Admin: set a customer's cap. null → use global default; -1 → unlimited. */
export async function setUserLimit(userId: string, limit: number | null): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO build_quota (user_id, build_limit) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET build_limit = $2, updated_at = now()`,
    [userId, limit],
  );
}

/** Admin: read a customer's usage + effective cap. */
export async function usageFor(userId: string): Promise<{ used: number; limit: number | null; override: number | null }> {
  const r = await row(userId);
  const limit = effectiveLimit(r.build_limit, env.FREE_BUILD_LIMIT);
  return {
    used: Number(r.builds_used),
    limit: Number.isFinite(limit) ? limit : null,
    override: r.build_limit,
  };
}
