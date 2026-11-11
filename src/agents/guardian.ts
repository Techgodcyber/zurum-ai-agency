import { callModel } from "../models/index.js";
import { isTrustedEmbedHost, isTrustedImageHost } from "../config/embeds.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "guardian" });

/**
 * Guardian — the QA + security + content-moderation gate (§4.5 / §5).
 *
 * Runs BEFORE the customer sees a preview. Two layers:
 *   1. Fast static checks (free): is the HTML well-formed, responsive, and truly
 *      self-contained (no external/remote resources, no obvious injection)?
 *   2. AI content moderation: does the generated CONTENT violate the AUP
 *      (phishing/impersonation of a real brand, malware, illegal, hateful)?
 *      Scribe checks the request; Guardian checks what Forge actually produced.
 *
 * `critical` failures block the build; non-critical issues are warnings.
 */

export interface GuardianReport {
  passed: boolean;
  critical: boolean;
  issues: string[];
  costUsd: number;
}

/**
 * Layer 1 — static structural + self-containment/security checks.
 *
 * `allowExternal` relaxes the self-containment rule for HIGH-FIDELITY CLONES: a
 * cloned site legitimately references the original's images/CSS/fonts, and clones
 * already have every <script> stripped, so external MEDIA is safe there. The
 * dangerous-JS and phishing backstops still run in all cases.
 */
export function staticChecks(
  html: string,
  allowExternal = false,
): { issues: string[]; critical: boolean } {
  const issues: string[] = [];
  let critical = false;

  if (!/^<!DOCTYPE html/i.test(html.trim())) issues.push("missing <!DOCTYPE html>");
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) {
    issues.push("missing or unclosed <html> (possibly truncated)");
    critical = true;
  }
  if (!/<title[\s>]/i.test(html)) issues.push("missing <title>");
  if (!/name=["']viewport["']/i.test(html))
    issues.push("missing responsive viewport meta");
  if (html.length < 800) {
    issues.push("suspiciously small output");
    critical = true;
  }

  // Self-containment with a few deliberate exceptions:
  //   - Outbound <a href> LINKS are always fine (WhatsApp, socials, maps, tel:).
  //   - Scripts/frames from TRUSTED_EMBED_HOSTS (live-chat widgets) are allowed.
  //   - IMAGES (and CSS background images) from TRUSTED_IMAGE_HOSTS (Pexels etc.)
  //     are allowed — real photography is what makes a site look rich.
  // Executable/frame resources (script/iframe/object/embed) must be embed hosts;
  // media resources (img/video/CSS url) may also be trusted image CDNs.
  const execUrls: string[] = [];
  const mediaUrls: string[] = [];
  const capture = (re: RegExp, into: string[]) => {
    for (const m of html.matchAll(re)) into.push(m[1]!);
  };
  capture(/<(?:script|iframe|embed|object)\b[^>]*\b(?:src|data)\s*=\s*["'](https?:\/\/[^"']+)/gi, execUrls);
  capture(/<(?:img|source|video|audio|track|image)\b[^>]*\b(?:src|href|xlink:href)\s*=\s*["'](https?:\/\/[^"']+)/gi, mediaUrls);
  capture(/<link\b[^>]*\bhref\s*=\s*["'](https?:\/\/[^"']+)/gi, execUrls); // external CSS
  capture(/url\(\s*["']?(https?:\/\/[^"')]+)/gi, mediaUrls); // CSS background images / fonts

  const badExec = execUrls.filter((u) => !isTrustedEmbedHost(u));
  const badMedia = mediaUrls.filter((u) => !isTrustedEmbedHost(u) && !isTrustedImageHost(u));
  const untrusted = [...badExec, ...badMedia];
  if (untrusted.length && !allowExternal) {
    issues.push(
      `${untrusted.length} disallowed external resource(s) — only approved image/widget hosts are permitted`,
    );
    critical = true;
  }
  if (/\beval\s*\(|\bdocument\.write\s*\(|\bnew\s+Function\s*\(/i.test(html)) {
    issues.push("dangerous JS sink (eval/document.write/Function)");
    critical = true;
  }

  // Deterministic phishing backstop (model moderation is unreliable on some
  // providers). Trips only when a KNOWN brand is impersonated AND credentials
  // are collected AND harvesting language is present — so generic login forms
  // for the customer's own business are unaffected.
  const brand =
    /(paypal|chase|bank of america|wells fargo|citibank|barclays|hsbc|apple\s*id|microsoft account|google account|coinbase|binance|netflix|amazon|instagram|facebook|whatsapp)/i;
  const passwordField = /<input[^>]*type=["']password["']/i.test(html);
  const harvest =
    /(verify your account|confirm your (identity|account)|sign in to (verify|confirm)|update your (payment|billing)|enter your (password|pin|card number))/i;
  if (passwordField && brand.test(html) && harvest.test(html)) {
    issues.push("likely phishing: impersonates a known brand and collects credentials");
    critical = true;
  }

  return { issues, critical };
}

/** Layer 2 — AI content moderation against the AUP. Returns pass + reason. */
async function moderate(
  html: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; reason: string; costUsd: number }> {
  // Send only the visible text to keep it cheap and focused on content.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6_000);

  const res = await callModel("guardian", {
    system:
      "You are Guardian, a PERMISSIVE content-safety reviewer for a website builder. " +
      "Almost everything is acceptable: business sites, portfolios, shops, and GENERIC " +
      "banking / fintech / crypto / web3 / casino / betting / gambling / adult frontends are " +
      "ALL fine as long as they do not impersonate a REAL, NAMED company or bank. Only reject " +
      "CLEAR abuse. " +
      "Reply with exactly 'OK' when acceptable. Reply 'BLOCK: <short reason>' ONLY for: " +
      "phishing or impersonating a real named brand/bank to steal credentials, malware, or " +
      "clearly illegal content. When unsure, reply 'OK'.",
    messages: [{ role: "user", content: text }],
    maxTokens: 40,
    thinking: false,
    jobId: "guardian-moderate",
    signal,
  });

  // Fail OPEN: only block on an explicit "BLOCK:" verdict. Ambiguous or oddly
  // formatted replies (common on fast models) default to allow, so benign sites
  // are never killed by a formatting quirk.
  const out = res.text.trim();
  const blocked = out.match(/\bBLOCK:\s*(.+)/i);
  if (blocked) return { ok: false, reason: blocked[1]!.trim(), costUsd: res.costUsd };
  return { ok: true, reason: "", costUsd: res.costUsd };
}

/** Run the full Guardian gate over a generated site. */
export async function review(
  html: string,
  signal?: AbortSignal,
  allowExternal = false,
): Promise<GuardianReport> {
  const stat = staticChecks(html, allowExternal);
  const mod = await moderate(html, signal);

  const issues = [...stat.issues];
  if (!mod.ok) issues.push(`content blocked: ${mod.reason}`);

  const critical = stat.critical || !mod.ok;
  const passed = !critical;

  log.info({ passed, critical, issues }, "guardian review");
  return { passed, critical, issues, costUsd: mod.costUsd };
}
