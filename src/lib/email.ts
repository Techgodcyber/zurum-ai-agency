import { env } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Transactional email — a thin seam over Resend's HTTP API (no dependency, just
 * fetch). Used for customer-site password resets and email verification.
 *
 * Gated on RESEND_API_KEY: if it isn't set, `sendEmail` returns
 * {sent:false, reason:"not_configured"} and logs a warning, so callers degrade
 * gracefully instead of crashing (same pattern as the other optional providers).
 * Any other provider can be swapped in here later without touching callers.
 */

const log = logger.child({ mod: "email" });

export function isEmailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY);
}

export interface SendResult {
  sent: boolean;
  reason?: string;
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  signal?: AbortSignal;
}): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    log.warn({ to: args.to }, "email not configured (RESEND_API_KEY unset) — skipping send");
    return { sent: false, reason: "not_configured" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: args.from ?? env.EMAIL_FROM,
        to: [args.to],
        subject: args.subject,
        html: args.html,
        text: args.text ?? stripHtml(args.html),
      }),
      signal: args.signal ?? AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => String(res.status));
      log.error({ to: args.to, status: res.status, detail: detail.slice(0, 300) }, "email send failed");
      return { sent: false, reason: `provider_${res.status}` };
    }
    log.info({ to: args.to, subject: args.subject }, "email sent");
    return { sent: true };
  } catch (err) {
    log.error({ err, to: args.to }, "email send error");
    return { sent: false, reason: "error" };
  }
}

/** Plain-text fallback for clients that don't render HTML. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
