import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../lib/logger.js";
import {
  authenticateUser,
  createEmailVerification,
  createPasswordReset,
  createRecord,
  createSession,
  deleteRecord,
  destroySession,
  getSiteBackend,
  listRecords,
  newVerificationFor,
  registerUser,
  resetPassword,
  updateRecord,
  userForToken,
  verifyEmail,
  type SiteUser,
} from "./store.js";
import { ZURUM_SDK_JS } from "./sdk.js";
import { checkout, confirmOrder, listProducts, getStoreInfo, type Order } from "./commerce.js";
import { recordEvent } from "../growth/analytics.js";
import { getUpload, MAX_UPLOAD_BYTES, saveUpload } from "./uploads.js";
import { resetEmail, resetPageHtml, verifiedPageHtml, verifyEmailTemplate } from "./emails.js";
import { isEmailConfigured, sendEmail } from "../lib/email.js";
import { getHosting } from "../launch/hosting-store.js";
import { env } from "../config/env.js";
import * as conv from "../conversations/store.js";
import type { ChannelName, OutboundSender } from "../channels/types.js";

/**
 * HTTP front door for the multi-tenant customer-site backend (§14).
 *
 * Every generated site with a login or a dashboard calls these endpoints,
 * scoped to its own siteId:
 *   POST /api/:siteId/auth/register   {email,password,name?}  → {token,user}
 *   POST /api/:siteId/auth/login      {email,password}        → {token,user}
 *   POST /api/:siteId/auth/logout     (Bearer)                → {ok}
 *   GET  /api/:siteId/auth/me         (Bearer)                → {user}
 *   POST /api/:siteId/data/:coll      {data,shared?}          → {record}
 *   GET  /api/:siteId/data/:coll      (Bearer)                → {records}
 *   DELETE /api/:siteId/data/:coll/:id (Bearer)               → {ok}
 *
 * Hardening: per-site backend gate (invisible 404 if off), CORS locked to the
 * site's own origins, per-IP rate limits on every route, strict input caps, and
 * all storage via parameterised queries (see store.ts).
 */

const log = logger.child({ mod: "backend-api" });

const MAX_BODY = 64 * 1024; // 64KB request-body cap
const MAX_DATA_JSON = 32 * 1024; // 32KB per stored record
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLLECTION_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

// ── Rate limiting (in-memory sliding window; single-process is fine here) ──
const HITS = new Map<string, number[]>();
function rateLimited(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (HITS.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  HITS.set(key, arr);
  return arr.length > limit;
}
// Periodic cleanup so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of HITS) {
    const live = arr.filter((t) => now - t < 60_000);
    if (live.length) HITS.set(k, live);
    else HITS.delete(k);
  }
}, 300_000).unref();

function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  if (typeof xff === "string" && xff) return xff.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(h);
  return m ? m[1]! : null;
}

/** Read a raw request body (for file uploads), bounded to `max` bytes. */
async function readRawBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function corsHeaders(allowOrigin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    vary: "Origin",
  };
  if (allowOrigin) {
    h["access-control-allow-origin"] = allowOrigin;
    h["access-control-allow-methods"] = "GET,POST,PATCH,DELETE,OPTIONS";
    h["access-control-allow-headers"] = "content-type,authorization";
    h["access-control-max-age"] = "86400";
  }
  return h;
}

function json(
  res: ServerResponse,
  code: number,
  body: unknown,
  allowOrigin: string | null,
): void {
  res.writeHead(code, corsHeaders(allowOrigin));
  res.end(JSON.stringify(body));
}

const publicUser = (u: SiteUser) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  data: u.data,
  emailVerified: u.emailVerified,
});

/** Build the email-verification link for a site + token. */
function verifyLink(siteId: string, token: string): string {
  const base = env.PUBLIC_BASE_URL ?? "";
  return `${base}/api/${encodeURIComponent(siteId)}/auth/verify?token=${token}`;
}

/** Send a "confirm your email" message (best-effort; no-op if email isn't set up). */
async function sendVerificationEmail(siteId: string, email: string, token: string): Promise<void> {
  if (!isEmailConfigured()) return;
  const hosting = await getHosting(siteId);
  const siteName = hosting?.publicUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? "your account";
  const { subject, html } = verifyEmailTemplate(verifyLink(siteId, token), siteName);
  await sendEmail({ to: email, subject, html });
}

/**
 * Handle an /api/* request. Returns true if it took ownership of the response.
 * preview-server delegates here for any path starting with /api/.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  sender?: OutboundSender,
): Promise<boolean> {
  // The central front-end SDK — one file served to every site (§14.5). Public,
  // cacheable, permissive CORS (it's a static asset, not tenant data).
  if (path === "/api/zurum-auth.js") {
    res.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    });
    res.end(ZURUM_SDK_JS);
    return true;
  }

  // /api/<siteId>/<area>/<rest...>
  const parts = path.replace(/^\/api\//, "").split("/").filter(Boolean);
  const siteId = parts[0];
  const area = parts[1];
  const rest = parts.slice(2);
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;

  if (!siteId || !area) {
    json(res, 404, { error: "not_found" }, null);
    return true;
  }

  // Analytics beacon — works on ANY published site (no backend needed), write-only.
  if (area === "track") return handleTrack(req, res, siteId, origin);

  // Per-site gate: an unknown/disabled site's backend is INVISIBLE (plain 404),
  // so probing random site ids reveals nothing.
  const backend = await getSiteBackend(siteId);
  if (!backend || !backend.enabled) {
    json(res, 404, { error: "not_found" }, null);
    return true;
  }

  // CORS: reflect the Origin only if it's one of the site's own origins. Non-
  // browser callers (no Origin header) still work — CORS only gates browsers.
  const allowOrigin = origin && backend.allowedOrigins.includes(origin) ? origin : null;

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(allowOrigin));
    res.end();
    return true;
  }

  const ip = clientIp(req);
  try {
    if (area === "auth") return await handleAuth(req, res, siteId, rest[0] ?? "", ip, allowOrigin, sender);
    if (area === "data") return await handleData(req, res, siteId, rest, ip, allowOrigin);
    if (area === "upload") return await handleUpload(req, res, siteId, ip, allowOrigin);
    if (area === "uploads") return await handleServeUpload(req, res, siteId, rest[0] ?? "");
    if (area === "products") return await handleProducts(req, res, siteId, allowOrigin);
    if (area === "checkout") return await handleCheckout(req, res, siteId, ip, allowOrigin);
    if (area === "order") return await handleOrder(req, res, siteId, rest, sender);
    json(res, 404, { error: "not_found" }, allowOrigin);
    return true;
  } catch (err) {
    if ((err as Error).message === "body too large") {
      json(res, 413, { error: "payload_too_large" }, allowOrigin);
    } else if ((err as Error).message === "invalid json") {
      json(res, 400, { error: "invalid_json" }, allowOrigin);
    } else {
      log.error({ err, siteId, area }, "backend request failed");
      json(res, 500, { error: "server_error" }, allowOrigin);
    }
    return true;
  }
}

// ── Auth routes ──────────────────────────────────────────

async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  siteId: string,
  action: string,
  ip: string,
  allowOrigin: string | null,
  sender?: OutboundSender,
): Promise<boolean> {
  if (action === "me") {
    if (req.method !== "GET") return methodNotAllowed(res, allowOrigin);
    const user = await userForToken(siteId, bearer(req));
    if (!user) return json(res, 401, { error: "unauthorized" }, allowOrigin), true;
    return json(res, 200, { user: publicUser(user) }, allowOrigin), true;
  }

  if (action === "logout") {
    if (req.method !== "POST") return methodNotAllowed(res, allowOrigin);
    await destroySession(bearer(req));
    return json(res, 200, { ok: true }, allowOrigin), true;
  }

  // Forgot-password: create a token + email a reset link. ALWAYS returns ok so
  // it can't be used to probe which emails are registered (§ enumeration).
  if (action === "request-reset") {
    if (req.method !== "POST") return methodNotAllowed(res, allowOrigin);
    if (rateLimited(`reset:${ip}:${siteId}`, 10)) {
      return json(res, 429, { error: "rate_limited" }, allowOrigin), true;
    }
    const body = (await readBody(req)) as Record<string, unknown>;
    const email = String(body.email ?? "").trim().toLowerCase();
    if (EMAIL_RE.test(email) && email.length <= 254) {
      const reset = await createPasswordReset(siteId, email);
      if (reset && isEmailConfigured()) {
        const base = env.PUBLIC_BASE_URL ?? "";
        const link = `${base}/api/${encodeURIComponent(siteId)}/auth/reset?token=${reset.token}`;
        const hosting = await getHosting(siteId);
        const siteName = hosting?.publicUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? "your account";
        const { subject, html } = resetEmail(link, siteName);
        void sendEmail({ to: email, subject, html }); // fire-and-forget
      }
    }
    return json(res, 200, { ok: true }, allowOrigin), true;
  }

  // Email verification: GET confirms via the emailed link; POST re-sends it.
  if (action === "verify") {
    if (req.method === "GET") {
      const token = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("token") ?? "";
      const ok = await verifyEmail(siteId, token);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" });
      res.end(verifiedPageHtml(ok));
      return true;
    }
    return methodNotAllowed(res, allowOrigin);
  }
  if (action === "resend-verification") {
    if (req.method !== "POST") return methodNotAllowed(res, allowOrigin);
    if (rateLimited(`verify:${ip}:${siteId}`, 6)) {
      return json(res, 429, { error: "rate_limited" }, allowOrigin), true;
    }
    // The logged-in user (or an email in the body) requests a fresh link.
    const user = await userForToken(siteId, bearer(req));
    let emailAddr = user?.email ?? "";
    if (!emailAddr) {
      const body = (await readBody(req)) as Record<string, unknown>;
      emailAddr = String(body.email ?? "").trim().toLowerCase();
    }
    if (EMAIL_RE.test(emailAddr)) {
      const v = await newVerificationFor(siteId, emailAddr);
      if (v) void sendVerificationEmail(siteId, v.user.email, v.token);
    }
    return json(res, 200, { ok: true }, allowOrigin), true; // enumeration-safe
  }

  // Reset: GET serves the hosted new-password page; POST performs the reset.
  if (action === "reset") {
    if (req.method === "GET") {
      const token = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("token") ?? "";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" });
      res.end(resetPageHtml(siteId, token));
      return true;
    }
    if (req.method !== "POST") return methodNotAllowed(res, allowOrigin);
    if (rateLimited(`reset:${ip}:${siteId}`, 20)) {
      return json(res, 429, { error: "rate_limited" }, allowOrigin), true;
    }
    const body = (await readBody(req)) as Record<string, unknown>;
    const token = String(body.token ?? "");
    const password = String(body.password ?? "");
    if (password.length < 8 || password.length > 200) {
      return json(res, 400, { error: "weak_password" }, allowOrigin), true;
    }
    const ok = await resetPassword(siteId, token, password);
    return json(res, ok ? 200 : 400, ok ? { ok: true } : { error: "invalid_token" }, allowOrigin), true;
  }

  if (action === "register" || action === "login") {
    if (req.method !== "POST") return methodNotAllowed(res, allowOrigin);
    // Auth endpoints are the brute-force target — tight limit per IP+site.
    if (rateLimited(`auth:${ip}:${siteId}`, 20)) {
      return json(res, 429, { error: "rate_limited" }, allowOrigin), true;
    }
    const body = (await readBody(req)) as Record<string, unknown>;
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const name = body.name != null ? String(body.name).slice(0, 120) : null;

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return json(res, 400, { error: "invalid_email" }, allowOrigin), true;
    }
    if (password.length < 8 || password.length > 200) {
      return json(res, 400, { error: "weak_password", message: "Password must be 8–200 characters." }, allowOrigin), true;
    }

    if (action === "register") {
      const user = await registerUser(siteId, email, password, name);
      if (!user) return json(res, 409, { error: "email_taken" }, allowOrigin), true;
      const token = await createSession(siteId, user.id);
      void notifyNewUser(siteId, user, sender); // tell the site owner in their chat
      // Fire a "confirm your email" message (no-op if email isn't configured).
      void createEmailVerification(siteId, user.id)
        .then((vt) => sendVerificationEmail(siteId, user.email, vt))
        .catch((err) => log.warn({ err, siteId }, "verification email failed"));
      return json(res, 201, { token, user: publicUser(user) }, allowOrigin), true;
    }
    const user = await authenticateUser(siteId, email, password);
    if (!user) return json(res, 401, { error: "invalid_credentials" }, allowOrigin), true;
    const token = await createSession(siteId, user.id);
    return json(res, 200, { token, user: publicUser(user) }, allowOrigin), true;
  }

  return json(res, 404, { error: "not_found" }, allowOrigin), true;
}

// ── Data routes ──────────────────────────────────────────

async function handleData(
  req: IncomingMessage,
  res: ServerResponse,
  siteId: string,
  rest: string[],
  ip: string,
  allowOrigin: string | null,
): Promise<boolean> {
  const collection = rest[0] ?? "";
  if (!COLLECTION_RE.test(collection)) {
    return json(res, 400, { error: "invalid_collection" }, allowOrigin), true;
  }
  if (rateLimited(`data:${ip}:${siteId}`, 120)) {
    return json(res, 429, { error: "rate_limited" }, allowOrigin), true;
  }
  const user = await userForToken(siteId, bearer(req));

  // CREATE — authenticated → private to the user; anonymous → a shared record
  // (e.g. a public contact/booking form). `shared:true` forces shared even when
  // signed in.
  if (req.method === "POST") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;
    if (typeof data !== "object" || Array.isArray(data)) {
      return json(res, 400, { error: "invalid_data" }, allowOrigin), true;
    }
    if (JSON.stringify(data).length > MAX_DATA_JSON) {
      return json(res, 413, { error: "data_too_large" }, allowOrigin), true;
    }
    const owner = body.shared === true ? null : user?.id ?? null;
    const record = await createRecord(siteId, collection, owner, data);
    return json(res, 201, { record }, allowOrigin), true;
  }

  // LIST / UPDATE / DELETE require a signed-in user and are scoped to their own records.
  if (!user) return json(res, 401, { error: "unauthorized" }, allowOrigin), true;

  if (req.method === "GET") {
    const q = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
    const limit = Number(q.get("limit")) || 100;
    const offset = Number(q.get("offset")) || 0;
    const records = await listRecords(siteId, collection, user.id, limit, offset);
    return json(res, 200, { records }, allowOrigin), true;
  }
  if (req.method === "PATCH") {
    const id = rest[1] ?? "";
    if (!id) return json(res, 400, { error: "missing_id" }, allowOrigin), true;
    const body = (await readBody(req)) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;
    if (typeof data !== "object" || Array.isArray(data)) {
      return json(res, 400, { error: "invalid_data" }, allowOrigin), true;
    }
    if (JSON.stringify(data).length > MAX_DATA_JSON) {
      return json(res, 413, { error: "data_too_large" }, allowOrigin), true;
    }
    const record = await updateRecord(siteId, id, user.id, data);
    return json(res, record ? 200 : 404, record ? { record } : { error: "not_found" }, allowOrigin), true;
  }
  if (req.method === "DELETE") {
    const id = rest[1] ?? "";
    if (!id) return json(res, 400, { error: "missing_id" }, allowOrigin), true;
    const ok = await deleteRecord(siteId, id, user.id);
    return json(res, ok ? 200 : 404, { ok }, allowOrigin), true;
  }
  return methodNotAllowed(res, allowOrigin);
}

// ── Uploads ──────────────────────────────────────────────

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  siteId: string,
  ip: string,
  allowOrigin: string | null,
): Promise<boolean> {
  if (req.method !== "POST") return methodNotAllowed(res, allowOrigin);
  const user = await userForToken(siteId, bearer(req));
  if (!user) return json(res, 401, { error: "unauthorized" }, allowOrigin), true;
  if (rateLimited(`upload:${ip}:${siteId}`, 30)) {
    return json(res, 429, { error: "rate_limited" }, allowOrigin), true;
  }
  let buf: Buffer;
  try {
    buf = await readRawBody(req, MAX_UPLOAD_BYTES);
  } catch {
    return json(res, 413, { error: "file_too_large" }, allowOrigin), true;
  }
  const stored = await saveUpload(siteId, user.id, buf);
  if (!stored) {
    return json(res, 400, { error: "unsupported_file", message: "Only PNG, JPG, GIF or WEBP images up to 5MB." }, allowOrigin), true;
  }
  const base = env.PUBLIC_BASE_URL ?? "";
  const url = `${base}/api/${encodeURIComponent(siteId)}/uploads/${stored.id}`;
  return json(res, 201, { id: stored.id, url, mime: stored.mime, size: stored.size }, allowOrigin), true;
}

async function handleServeUpload(
  req: IncomingMessage,
  res: ServerResponse,
  siteId: string,
  id: string,
): Promise<boolean> {
  if (req.method !== "GET") return methodNotAllowed(res, null);
  if (!id) return json(res, 404, { error: "not_found" }, null), true;
  const file = await getUpload(siteId, id);
  if (!file) return json(res, 404, { error: "not_found" }, null), true;
  // Fixed validated image content-type + nosniff + inline disposition: an upload
  // can never be served as HTML/JS, so it can't execute (§14.4 L2).
  res.writeHead(200, {
    "content-type": file.mime,
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "cache-control": "public, max-age=31536000, immutable",
    "access-control-allow-origin": "*",
  });
  res.end(file.bytes);
  return true;
}

// ── Analytics beacon ─────────────────────────────────────

async function handleTrack(
  req: IncomingMessage,
  res: ServerResponse,
  siteId: string,
  origin: string | null,
): Promise<boolean> {
  const cors = { "access-control-allow-origin": origin ?? "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type" };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return true;
  }
  if (req.method !== "POST") {
    res.writeHead(405, cors);
    res.end();
    return true;
  }
  // Write-only + rate-limited per IP+site; over the limit we silently drop.
  if (!rateLimited(`track:${clientIp(req)}:${siteId}`, 600)) {
    try {
      const b = (await readBody(req)) as Record<string, unknown>;
      await recordEvent(
        siteId,
        b.vid != null ? String(b.vid) : null,
        b.path != null ? String(b.path) : null,
        b.ref != null ? String(b.ref) : null,
      );
    } catch {
      /* never fail a beacon */
    }
  }
  res.writeHead(204, cors);
  res.end();
  return true;
}

// ── Store (e-commerce) ───────────────────────────────────

async function handleProducts(
  req: IncomingMessage,
  res: ServerResponse,
  siteId: string,
  allowOrigin: string | null,
): Promise<boolean> {
  if (req.method !== "GET") return methodNotAllowed(res, allowOrigin);
  const [products, store] = await Promise.all([listProducts(siteId, true), getStoreInfo(siteId)]);
  return json(res, 200, { products, currency: store.currency, canCheckout: store.live }, allowOrigin), true;
}

async function handleCheckout(
  req: IncomingMessage,
  res: ServerResponse,
  siteId: string,
  ip: string,
  allowOrigin: string | null,
): Promise<boolean> {
  if (req.method !== "POST") return methodNotAllowed(res, allowOrigin);
  if (rateLimited(`checkout:${ip}:${siteId}`, 20)) {
    return json(res, 429, { error: "rate_limited" }, allowOrigin), true;
  }
  const body = (await readBody(req)) as Record<string, unknown>;
  const cart = Array.isArray(body.items)
    ? (body.items as { productId?: unknown; qty?: unknown }[]).map((i) => ({
        productId: String(i.productId ?? ""),
        qty: Number(i.qty ?? 1),
      }))
    : [];
  const buyerIn = (body.buyer ?? {}) as Record<string, unknown>;
  const buyer = {
    name: buyerIn.name ? String(buyerIn.name).slice(0, 120) : undefined,
    email: buyerIn.email ? String(buyerIn.email).slice(0, 254) : undefined,
    phone: buyerIn.phone ? String(buyerIn.phone).slice(0, 32) : undefined,
  };
  const r = await checkout(siteId, cart, buyer);
  if (r.status === "ok") return json(res, 200, { url: r.checkoutUrl, orderId: r.orderId }, allowOrigin), true;
  const code = r.status === "not_configured" ? 503 : 400;
  const msg =
    r.status === "not_configured"
      ? "This store isn't accepting payments yet."
      : r.status === "empty"
        ? "Your cart is empty."
        : "We couldn't start checkout. Please try again.";
  return json(res, code, { error: r.status, message: msg }, allowOrigin), true;
}

async function handleOrder(
  req: IncomingMessage,
  res: ServerResponse,
  siteId: string,
  rest: string[],
  sender?: OutboundSender,
): Promise<boolean> {
  const q = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const ref = q.get("tx_ref") ?? q.get("ref") ?? "";

  // Buyer lands here after paying on Flutterwave (a top-level redirect, no CORS).
  if (rest[0] === "return") {
    const order = ref ? await confirmOrder(siteId, ref) : null;
    if (order?.status === "paid") void notifyOrder(siteId, order, sender);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" });
    res.end(orderReturnPage(order));
    return true;
  }
  // JSON status (for a site that wants to poll).
  if (rest[0] === "status") {
    const order = ref ? await confirmOrder(siteId, ref) : null;
    if (order?.status === "paid") void notifyOrder(siteId, order, sender);
    return json(res, order ? 200 : 404, order ? { status: order.status, amount: order.amount } : { error: "not_found" }, null), true;
  }
  return json(res, 404, { error: "not_found" }, null), true;
}

/** Tell the merchant (site owner) in their chat that they made a sale. */
async function notifyOrder(siteId: string, order: Order, sender?: OutboundSender): Promise<void> {
  if (!sender) return;
  try {
    const c = await conv.bySite(siteId);
    if (!c) return;
    const items = order.items.map((i) => `• ${i.qty}× ${i.name}`).join("\n");
    const who = order.buyerName || order.buyerEmail || order.buyerPhone || "a customer";
    await sender.send(
      c.channel as ChannelName,
      c.chatId,
      `🛒 New SALE on your website! 🎉\n\n${order.currency} ${order.amount.toLocaleString()} from ${who}:\n${items}\n\nThe money goes straight to your payment account.`,
    );
  } catch (err) {
    log.warn({ err, siteId }, "order notification failed");
  }
}

function orderReturnPage(order: Order | null): string {
  const ok = order?.status === "paid";
  const body = ok
    ? `<div class="i">✅</div><h1>Payment received</h1><p>Thank you! Your order is confirmed${order && order.amount ? ` (${order.currency} ${order.amount.toLocaleString()})` : ""}. A receipt has been recorded.</p>`
    : `<div class="i">⌛</div><h1>Payment not confirmed yet</h1><p>If you completed the payment, it may take a moment to reflect. You can close this page — your order will update automatically.</p>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Order</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f1f5f9;color:#0f172a}
@media(prefers-color-scheme:dark){body{background:#0b1220;color:#e2e8f0}.c{background:#111827 !important;border-color:#1f2937 !important}}
.c{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:32px;width:min(92vw,380px);text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.08)}
.i{font-size:44px;margin-bottom:8px}h1{font-size:20px;margin:0 0 6px}p{margin:0;color:#64748b;font-size:14px}
</style></head><body><div class="c">${body}</div></body></html>`;
}

function methodNotAllowed(res: ServerResponse, allowOrigin: string | null): boolean {
  json(res, 405, { error: "method_not_allowed" }, allowOrigin);
  return true;
}

/** Tell the site owner, in their chat, that someone signed up on their site. */
async function notifyNewUser(siteId: string, user: SiteUser, sender?: OutboundSender): Promise<void> {
  if (!sender) return;
  try {
    const c = await conv.bySite(siteId);
    if (!c) return;
    const who = user.name ? `${user.name} (${user.email})` : user.email;
    await sender.send(
      c.channel as ChannelName,
      c.chatId,
      `🎉 New signup on your website!\n\n• ${who}\n\nThat's a real account created on your site.`,
    );
  } catch (err) {
    log.warn({ err, siteId }, "new-user owner notification failed");
  }
}
