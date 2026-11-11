import type { IncomingMessage } from "node:http";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

/**
 * Admin access guards. Hiding the URL only filters out noisy scanners — these are
 * the controls that actually stop a determined attacker:
 *
 *  1. IP allowlist (optional, strongest when the team has fixed IPs)
 *  2. Login lockout with escalating backoff, keyed on BOTH the client IP and the
 *     account, so neither password-spraying one account nor rotating accounts
 *     from one IP gets unlimited attempts
 *
 * State is in-memory: it resets on restart (acceptable — an attacker can't force
 * a restart) and needs no extra infrastructure.
 */

const log = logger.child({ mod: "admin-guard" });

// ── Client IP ────────────────────────────────────────────

/** Real client IP, honouring the proxy headers nginx/Cloudflare set. */
export function clientIp(req: IncomingMessage): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf.trim();
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

// ── IP allowlist ─────────────────────────────────────────

const allowlist = (env.ADMIN_IP_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function ipAllowed(ip: string): boolean {
  if (!allowlist.length) return true; // not configured → open (rely on other controls)
  // Normalise IPv4-mapped IPv6 (::ffff:1.2.3.4) so entries match either form.
  const norm = ip.replace(/^::ffff:/, "");
  return allowlist.some((a) => a === ip || a === norm);
}

export const hasIpAllowlist = allowlist.length > 0;

// ── Login lockout ────────────────────────────────────────

interface Bucket {
  fails: number;
  lockedUntil: number;
}
const buckets = new Map<string, Bucket>();

/** Drop stale buckets so the map can't grow forever. */
function sweep(): void {
  if (buckets.size < 5000) return;
  const now = Date.now();
  for (const [k, b] of buckets) if (b.lockedUntil < now && b.fails === 0) buckets.delete(k);
}

/** Seconds remaining on a lockout for this key (0 = not locked). */
export function lockedFor(key: string): number {
  const b = buckets.get(key);
  if (!b || b.lockedUntil <= Date.now()) return 0;
  return Math.ceil((b.lockedUntil - Date.now()) / 1000);
}

/**
 * Seconds remaining if EITHER the IP or the account is locked. Checking both
 * stops password-spraying (many accounts, one IP) and distributed guessing
 * (one account, many IPs).
 */
export function loginLocked(ip: string, email: string): number {
  return Math.max(lockedFor(`ip:${ip}`), lockedFor(`user:${email.trim().toLowerCase()}`));
}

/** Record a failed login; locks out with escalating backoff past the threshold. */
export function recordFailure(ip: string, email: string): void {
  sweep();
  for (const key of [`ip:${ip}`, `user:${email.trim().toLowerCase()}`]) {
    const b = buckets.get(key) ?? { fails: 0, lockedUntil: 0 };
    b.fails += 1;
    if (b.fails >= env.ADMIN_MAX_LOGIN_ATTEMPTS) {
      // Escalate: 15min, 30min, 60min, … capped at 24h.
      const over = b.fails - env.ADMIN_MAX_LOGIN_ATTEMPTS;
      const minutes = Math.min(env.ADMIN_LOCKOUT_MINUTES * 2 ** over, 1440);
      b.lockedUntil = Date.now() + minutes * 60_000;
      log.warn({ key, fails: b.fails, minutes }, "admin login locked out");
    }
    buckets.set(key, b);
  }
}

/** Successful login — clear the counters for that IP + account. */
export function recordSuccess(ip: string, email: string): void {
  buckets.delete(`ip:${ip}`);
  buckets.delete(`user:${email.trim().toLowerCase()}`);
}

/** For the boot log / ops visibility. */
export function guardSummary(): Record<string, unknown> {
  return {
    path: env.ADMIN_PATH,
    hidden: env.ADMIN_PATH !== "/admin",
    ipAllowlist: allowlist.length ? `${allowlist.length} address(es)` : "off",
    lockout: `${env.ADMIN_MAX_LOGIN_ATTEMPTS} attempts / ${env.ADMIN_LOCKOUT_MINUTES}min`,
  };
}
