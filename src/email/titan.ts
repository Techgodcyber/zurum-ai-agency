import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";

/**
 * Titan business-email provisioning (partner API). Creates real mailboxes like
 * support@theircompany.com on the customer's own domain, as a paid upsell.
 *
 * Gated on TITAN_API_KEY — until the partner key is pasted in, isTitanConfigured()
 * is false and the chat feature says "coming soon". API shapes follow Titan's
 * partner docs (createMailOrder → createEmailAccount → generateDKIMKeys); the
 * first LIVE provisioning should be verified once the real key is in.
 */

const log = logger.child({ mod: "titan" });

export function isTitanConfigured(): boolean {
  return Boolean(env.TITAN_API_KEY);
}

interface DnsRecord {
  type: "MX" | "TXT" | "CNAME";
  name: string;
  value: string;
  priority?: number;
}
export interface MailboxResult {
  email: string;
  password: string;
  webmailUrl: string;
  dns: DnsRecord[];
}

async function titan<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${env.TITAN_API_URL}/${path}`, {
    method: "POST",
    headers: { authorization: String(env.TITAN_API_KEY), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) throw new Error(`titan ${path} → ${res.status}: ${json.message ?? json.error ?? "error"}`);
  return json;
}

// ── Order per domain (reused across mailboxes on that domain) ──

async function getOrder(domain: string): Promise<number | null> {
  const db = await getDb();
  const rows = await db.query<{ titan_order_id: string }>(
    `SELECT titan_order_id FROM mailbox_orders WHERE domain = $1`,
    [domain],
  );
  return rows[0] ? Number(rows[0].titan_order_id) : null;
}

async function ensureOrder(domain: string, customerId: string, signal?: AbortSignal): Promise<number> {
  const existing = await getOrder(domain);
  if (existing) return existing;
  const body: Record<string, unknown> = { domainName: domain, customerId, planType: env.TITAN_PLAN };
  if (env.TITAN_PLAN !== "free") {
    body.noOfAccounts = 1;
    body.expiryDate = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    body.chargedAmount = 0;
    body.currency = "USD";
  }
  const order = await titan<{ titanOrderId: number }>("createMailOrder", body, signal);
  const db = await getDb();
  await db.query(
    `INSERT INTO mailbox_orders (domain, titan_order_id) VALUES ($1, $2)
     ON CONFLICT (domain) DO NOTHING`,
    [domain, order.titanOrderId],
  );
  log.info({ domain, titanOrderId: order.titanOrderId }, "titan mail order created");
  return order.titanOrderId;
}

function strongPassword(): string {
  // 16 chars, url-safe, with guaranteed variety Titan accepts.
  return "Zu" + randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "") + "9!";
}

/**
 * Provision a mailbox (e.g. support@domain) on the customer's domain. Idempotent
 * on the email address. Returns the login details + the DNS records the domain
 * needs (MX/SPF/DKIM) for mail to flow.
 */
export async function provisionMailbox(
  domain: string,
  localPart: string,
  opts: { customerId: string; userId?: string | null; name?: string },
  signal?: AbortSignal,
): Promise<MailboxResult | { status: "not_configured" } | { status: "exists"; email: string }> {
  if (!isTitanConfigured()) return { status: "not_configured" };
  const email = `${localPart.toLowerCase()}@${domain.toLowerCase()}`;
  const db = await getDb();
  const dup = await db.query<{ email: string }>(`SELECT email FROM site_mailboxes WHERE email = $1`, [email]);
  if (dup[0]) return { status: "exists", email };

  const orderId = await ensureOrder(domain, opts.customerId, signal);
  const password = strongPassword();
  const account = await titan<{ titanAccountId: number; webmailAutoLoginToken?: string }>(
    "createEmailAccount",
    { titanOrderId: orderId, email, password, name: opts.name, isAdmin: true, sendWelcomeEmail: false, requireAutoLoginToken: true },
    signal,
  );
  await db.query(
    `INSERT INTO site_mailboxes (user_id, domain, email, titan_account_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING`,
    [opts.userId ?? null, domain, email, account.titanAccountId],
  );

  // DKIM (best-effort — needs the order's generated selector).
  let dkim: DnsRecord | null = null;
  try {
    const d = await titan<{ selector?: string; host?: string; value?: string; record?: string }>(
      "generateDKIMKeys",
      { titanOrderId: orderId },
      signal,
    );
    const host = d.host ?? (d.selector ? `${d.selector}._domainkey.${domain}` : null);
    const value = d.value ?? d.record ?? null;
    if (host && value) dkim = { type: "TXT", name: host, value };
  } catch (err) {
    log.warn({ err: (err as Error).message, domain }, "titan DKIM fetch failed (add later)");
  }

  const dns: DnsRecord[] = [
    { type: "MX", name: domain, value: "mx1.titan.email", priority: 10 },
    { type: "MX", name: domain, value: "mx2.titan.email", priority: 20 },
    { type: "TXT", name: domain, value: "v=spf1 include:spf.titan.email ~all" },
    ...(dkim ? [dkim] : []),
  ];
  const webmailUrl = account.webmailAutoLoginToken
    ? `https://mail.titan.email/login?token=${account.webmailAutoLoginToken}`
    : "https://mail.titan.email";

  log.info({ email, domain }, "titan mailbox provisioned");
  return { email, password, webmailUrl, dns };
}

/** Render DNS records as plain steps for the customer to add. */
export function dnsSteps(dns: { type: string; name: string; value: string; priority?: number }[]): string {
  return dns
    .map((r, i) => `  ${i + 1}) ${r.type}${r.priority ? ` (priority ${r.priority})` : ""}  ·  Name: ${r.name}  ·  Value: ${r.value}`)
    .join("\n");
}
