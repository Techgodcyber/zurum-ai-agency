import { getDb } from "../db/index.js";
import { readSiteFiles } from "../sites/store.js";
import { zipFiles } from "./archive.js";

/**
 * "Own Your Data" export (a paid perk of a published site). Bundles the whole
 * portable package the customer is entitled to walk away with:
 *   - /site/*  — their site's code (pages), and
 *   - /data/*.csv — their BUSINESS data: form leads, registered customers,
 *     orders, dashboard records, and traffic.
 *
 * IP boundary: this only ever includes the customer's OWN rendered output and
 * their own captured data. It never touches Zurum's engine, prompts, backend
 * source, or any other tenant's rows (every query is scoped by site_id).
 */

// ── CSV helpers (RFC-4180 quoting) ──

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}

const CAP = 50_000; // hard cap per table so an export can't be unbounded

/**
 * Gather the customer's business data for one site as a set of CSV files. Only
 * non-empty tables are included, so the bundle is never cluttered with blank CSVs.
 */
export async function siteDataCsvs(siteId: string): Promise<Map<string, string>> {
  const db = await getDb();
  const out = new Map<string, string>();

  // Form submissions (leads). Flatten the jsonb `data` into columns from the
  // union of keys seen, so a spreadsheet opens cleanly.
  const subs = await db.query<{ form_name: string | null; data: Record<string, unknown>; created_at: string | Date }>(
    `SELECT form_name, data, created_at FROM form_submissions
      WHERE site_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
    [siteId],
  );
  if (subs.length) {
    const keys = [...new Set(subs.flatMap((s) => Object.keys(s.data ?? {})))];
    const headers = ["created_at", "form", ...keys];
    const rows = subs.map((s) => [String(s.created_at), s.form_name ?? "", ...keys.map((k) => s.data?.[k])]);
    out.set("data/form-submissions.csv", toCsv(headers, rows));
  }

  // Registered end-users (the site's own customers). Never export password hashes.
  const users = await db.query<{ email: string; name: string | null; email_verified: boolean; created_at: string | Date; last_login_at: string | Date | null }>(
    `SELECT email, name, email_verified, created_at, last_login_at FROM site_users
      WHERE site_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
    [siteId],
  );
  if (users.length) {
    out.set(
      "data/customers.csv",
      toCsv(
        ["email", "name", "email_verified", "created_at", "last_login_at"],
        users.map((u) => [u.email, u.name ?? "", u.email_verified, String(u.created_at), u.last_login_at ? String(u.last_login_at) : ""]),
      ),
    );
  }

  // Orders (their store's sales).
  const orders = await db.query<{ tx_ref: string; items: unknown; amount: string; currency: string; status: string; buyer_name: string | null; buyer_email: string | null; buyer_phone: string | null; created_at: string | Date; paid_at: string | Date | null }>(
    `SELECT tx_ref, items, amount, currency, status, buyer_name, buyer_email, buyer_phone, created_at, paid_at
       FROM site_orders WHERE site_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
    [siteId],
  );
  if (orders.length) {
    out.set(
      "data/orders.csv",
      toCsv(
        ["created_at", "tx_ref", "status", "amount", "currency", "buyer_name", "buyer_email", "buyer_phone", "paid_at", "items"],
        orders.map((o) => [String(o.created_at), o.tx_ref, o.status, o.amount, o.currency, o.buyer_name ?? "", o.buyer_email ?? "", o.buyer_phone ?? "", o.paid_at ? String(o.paid_at) : "", o.items]),
      ),
    );
  }

  // Generic dashboard records (bookings, saved items, etc.).
  const records = await db.query<{ collection: string; data: unknown; created_at: string | Date }>(
    `SELECT collection, data, created_at FROM site_records
      WHERE site_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
    [siteId],
  );
  if (records.length) {
    out.set(
      "data/records.csv",
      toCsv(["created_at", "collection", "data"], records.map((r) => [String(r.created_at), r.collection, r.data])),
    );
  }

  // Traffic (privacy-friendly pageviews — no PII).
  const events = await db.query<{ path: string | null; ref: string | null; vid: string | null; created_at: string | Date }>(
    `SELECT path, ref, vid, created_at FROM site_events
      WHERE site_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
    [siteId],
  );
  if (events.length) {
    out.set(
      "data/analytics.csv",
      toCsv(["created_at", "path", "referrer", "visitor_id"], events.map((e) => [String(e.created_at), e.path ?? "", e.ref ?? "", e.vid ?? ""])),
    );
  }

  return out;
}

function readme(siteId: string, hasCode: boolean, dataFiles: string[]): string {
  return [
    "ZURUM — YOUR DATA EXPORT",
    "========================",
    "",
    `Site: ${siteId}`,
    `Exported: ${new Date().toISOString()}`,
    "",
    "This bundle is yours to keep. It contains:",
    hasCode ? "  /site/     — your website's code (HTML/CSS/JS), one folder per page." : "  (site code was not available at export time)",
    dataFiles.length ? "  /data/     — your business data as CSV (open in Excel/Google Sheets):" : "  (no business data captured yet)",
    ...dataFiles.map((f) => `               • ${f.replace("data/", "")}`),
    "",
    "Notes:",
    "  • Passwords are never exported (only whether an email was verified).",
    "  • Analytics contain no personal identity — visitor_id is a random 1st-party id.",
    "  • This export is your data only; it does not include Zurum's platform code.",
    "",
    "Questions? Just message us in chat.",
    "",
  ].join("\n");
}

/**
 * Build the full portable ZIP for a site: code under /site + business data under
 * /data + a README. Returns the .zip bytes (no external dependency).
 */
export async function buildSiteExport(siteId: string): Promise<Buffer> {
  const bundle = new Map<string, string>();

  const code = await readSiteFiles(siteId);
  if (code) for (const [path, html] of code) bundle.set(`site${path.startsWith("/") ? path : `/${path}`}`, html);

  const data = await siteDataCsvs(siteId);
  for (const [path, csv] of data) bundle.set(path, csv);

  bundle.set("README.txt", readme(siteId, Boolean(code), [...data.keys()]));
  return zipFiles(bundle);
}
