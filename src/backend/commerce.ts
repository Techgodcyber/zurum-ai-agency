import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { getDb } from "../db/index.js";
import { encryptSecret, decryptSecret, isEncryptionConfigured } from "../lib/crypto-box.js";
import { enableSiteBackend } from "./store.js";
import { logger } from "../lib/logger.js";

/**
 * E-commerce building block: a customer's site sells to ITS buyers, and the
 * money goes to the MERCHANT (the Zurum customer) via their own payment provider
 * (Flutterwave). Their secret key is stored ENCRYPTED. Prices are looked up
 * server-side from site_products, so a buyer can never tamper with the amount.
 */

const log = logger.child({ mod: "commerce" });

// ── Payment config (the merchant's own provider key) ─────

export async function setPaymentConfig(
  siteId: string,
  secretKey: string,
  currency = "NGN",
  provider = "flutterwave",
): Promise<boolean> {
  if (!isEncryptionConfigured()) return false; // refuse to store a secret in the clear
  const enc = encryptSecret(secretKey.trim());
  if (!enc) return false;
  const db = await getDb();
  await db.query(
    `INSERT INTO site_payment_config (site_id, provider, secret_enc, currency, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (site_id) DO UPDATE SET provider = EXCLUDED.provider,
       secret_enc = EXCLUDED.secret_enc, currency = EXCLUDED.currency, updated_at = now()`,
    [siteId, provider, enc, currency.toUpperCase()],
  );
  await enableSiteBackend(siteId).catch(() => {}); // so store routes pass the API gate
  log.info({ siteId, provider, currency }, "merchant payment configured");
  return true;
}

/** Public-safe config (never returns the key). */
export async function getStoreInfo(
  siteId: string,
): Promise<{ live: boolean; provider: string; currency: string }> {
  const db = await getDb();
  const rows = await db.query<{ provider: string; secret_enc: string | null; currency: string }>(
    `SELECT provider, secret_enc, currency FROM site_payment_config WHERE site_id = $1`,
    [siteId],
  );
  const r = rows[0];
  return { live: Boolean(r?.secret_enc), provider: r?.provider ?? "flutterwave", currency: r?.currency ?? "NGN" };
}

async function merchantSecret(siteId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.query<{ secret_enc: string | null }>(
    `SELECT secret_enc FROM site_payment_config WHERE site_id = $1`,
    [siteId],
  );
  return decryptSecret(rows[0]?.secret_enc);
}

// ── Products ─────────────────────────────────────────────

export interface Product {
  id: string;
  name: string;
  price: number;
  currency: string;
  imageUrl: string | null;
  active: boolean;
}
interface ProductRow {
  id: string;
  name: string;
  price: string;
  currency: string;
  image_url: string | null;
  active: boolean;
}
const mapProduct = (r: ProductRow): Product => ({
  id: r.id,
  name: r.name,
  price: Number(r.price),
  currency: r.currency,
  imageUrl: r.image_url,
  active: r.active,
});

export async function addProduct(
  siteId: string,
  name: string,
  price: number,
  currency = "NGN",
  imageUrl: string | null = null,
): Promise<Product> {
  const db = await getDb();
  const rows = await db.query<ProductRow>(
    `INSERT INTO site_products (site_id, name, price, currency, image_url)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [siteId, name.slice(0, 200), price, currency.toUpperCase(), imageUrl],
  );
  await enableSiteBackend(siteId).catch(() => {}); // so /products passes the API gate
  return mapProduct(rows[0]!);
}

export async function listProducts(siteId: string, activeOnly = true): Promise<Product[]> {
  const db = await getDb();
  const rows = await db.query<ProductRow>(
    `SELECT * FROM site_products WHERE site_id = $1 ${activeOnly ? "AND active = true" : ""}
     ORDER BY created_at DESC LIMIT 200`,
    [siteId],
  );
  return rows.map(mapProduct);
}

export async function deleteProduct(siteId: string, id: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    `DELETE FROM site_products WHERE id = $1 AND site_id = $2 RETURNING id`,
    [id, siteId],
  );
  return rows.length > 0;
}

// ── Orders + checkout ────────────────────────────────────

export interface OrderItem {
  productId: string;
  name: string;
  price: number;
  qty: number;
}
export interface Order {
  id: string;
  txRef: string;
  items: OrderItem[];
  amount: number;
  currency: string;
  buyerName: string | null;
  buyerEmail: string | null;
  buyerPhone: string | null;
  status: string;
  createdAt: string;
}
interface OrderRow {
  id: string;
  tx_ref: string;
  items: OrderItem[];
  amount: string;
  currency: string;
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  status: string;
  created_at: string | Date;
}
const mapOrder = (r: OrderRow): Order => ({
  id: r.id,
  txRef: r.tx_ref,
  items: r.items ?? [],
  amount: Number(r.amount),
  currency: r.currency,
  buyerName: r.buyer_name,
  buyerEmail: r.buyer_email,
  buyerPhone: r.buyer_phone,
  status: r.status,
  createdAt: String(r.created_at),
});

export interface CheckoutResult {
  status: "ok" | "not_configured" | "empty" | "invalid";
  checkoutUrl?: string;
  orderId?: string;
  detail?: string;
}

/**
 * Create an order from a cart of {productId, qty} and start a payment on the
 * MERCHANT's Flutterwave account. Prices come from the DB (never the client).
 */
export async function checkout(
  siteId: string,
  cart: { productId: string; qty: number }[],
  buyer: { name?: string; email?: string; phone?: string },
  signal?: AbortSignal,
): Promise<CheckoutResult> {
  const secret = await merchantSecret(siteId);
  const info = await getStoreInfo(siteId);
  if (!secret) return { status: "not_configured" };
  if (!cart.length) return { status: "empty" };

  const products = await listProducts(siteId, true);
  const byId = new Map(products.map((p) => [p.id, p]));
  const items: OrderItem[] = [];
  let amount = 0;
  for (const line of cart) {
    const p = byId.get(line.productId);
    const qty = Math.max(1, Math.min(99, Math.floor(Number(line.qty) || 1)));
    if (!p) continue;
    items.push({ productId: p.id, name: p.name, price: p.price, qty });
    amount += p.price * qty;
  }
  if (!items.length || amount <= 0) return { status: "invalid", detail: "no valid items" };

  const currency = info.currency;
  const txRef = `zord-${randomBytes(8).toString("hex")}`;
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    `INSERT INTO site_orders (site_id, tx_ref, items, amount, currency, buyer_name, buyer_email, buyer_phone)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8) RETURNING id`,
    [siteId, txRef, JSON.stringify(items), amount, currency, buyer.name ?? null, buyer.email ?? null, buyer.phone ?? null],
  );
  const orderId = rows[0]!.id;

  const redirect = `${env.PUBLIC_BASE_URL ?? ""}/api/${encodeURIComponent(siteId)}/order/return`;
  try {
    const link = await createMerchantPayment(secret, {
      txRef,
      amount,
      currency,
      email: buyer.email || "buyer@example.com",
      name: buyer.name || "Customer",
      redirectUrl: redirect,
      title: "Checkout",
    }, signal);
    return { status: "ok", checkoutUrl: link, orderId };
  } catch (err) {
    log.error({ err: (err as Error).message, siteId }, "merchant payment create failed");
    return { status: "invalid", detail: "payment_provider_error" };
  }
}

/** Verify an order against the merchant's Flutterwave + mark it paid. */
export async function confirmOrder(
  siteId: string,
  txRef: string,
  signal?: AbortSignal,
): Promise<Order | null> {
  const db = await getDb();
  const existing = await db.query<OrderRow>(`SELECT * FROM site_orders WHERE site_id = $1 AND tx_ref = $2`, [siteId, txRef]);
  const order = existing[0];
  if (!order) return null;
  if (order.status === "paid") return mapOrder(order);

  const secret = await merchantSecret(siteId);
  if (!secret) return mapOrder(order);
  const paid = await verifyMerchantPayment(secret, txRef, signal);
  if (paid && paid.status === "successful" && Math.round(paid.amount) >= Math.round(Number(order.amount))) {
    const rows = await db.query<OrderRow>(
      `UPDATE site_orders SET status = 'paid', paid_at = now()
        WHERE site_id = $1 AND tx_ref = $2 AND status <> 'paid' RETURNING *`,
      [siteId, txRef],
    );
    log.info({ siteId, txRef, amount: order.amount }, "order paid");
    return mapOrder(rows[0] ?? order);
  }
  return mapOrder(order);
}

export async function listOrders(siteId: string, limit = 20): Promise<Order[]> {
  const db = await getDb();
  const capped = Math.min(Math.max(1, limit), 100);
  const rows = await db.query<OrderRow>(
    `SELECT * FROM site_orders WHERE site_id = $1 ORDER BY created_at DESC LIMIT ${capped}`,
    [siteId],
  );
  return rows.map(mapOrder);
}

export async function orderStats(siteId: string): Promise<{ orders: number; paid: number; revenue: number; currency: string }> {
  const db = await getDb();
  const rows = await db.query<{ orders: string; paid: string; revenue: string }>(
    `SELECT count(*) orders,
            count(*) FILTER (WHERE status = 'paid') paid,
            COALESCE(sum(amount) FILTER (WHERE status = 'paid'), 0) revenue
       FROM site_orders WHERE site_id = $1`,
    [siteId],
  );
  const info = await getStoreInfo(siteId);
  return {
    orders: Number(rows[0]?.orders ?? 0),
    paid: Number(rows[0]?.paid ?? 0),
    revenue: Number(rows[0]?.revenue ?? 0),
    currency: info.currency,
  };
}

// ── Flutterwave with the MERCHANT's key ──────────────────

async function fwMerchant<T>(secretKey: string, path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${env.FLUTTERWAVE_BASE_URL}${path}`, {
    ...init,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const json = (await res.json().catch(() => ({ status: "error" }))) as { status: string; message?: string; data: T };
  if (!res.ok || json.status !== "success") throw new Error(`flutterwave ${path} → ${res.status}: ${json.message ?? "error"}`);
  return json.data;
}

async function createMerchantPayment(
  secretKey: string,
  args: { txRef: string; amount: number; currency: string; email: string; name: string; redirectUrl: string; title: string },
  signal?: AbortSignal,
): Promise<string> {
  const data = await fwMerchant<{ link: string }>(
    secretKey,
    "/payments",
    {
      method: "POST",
      body: JSON.stringify({
        tx_ref: args.txRef,
        amount: args.amount,
        currency: args.currency,
        redirect_url: args.redirectUrl,
        customer: { email: args.email, name: args.name },
        customizations: { title: args.title, description: "Online order" },
        payment_options: "card,banktransfer,ussd,account",
      }),
    },
    signal,
  );
  return data.link;
}

async function verifyMerchantPayment(
  secretKey: string,
  txRef: string,
  signal?: AbortSignal,
): Promise<{ status: string; amount: number; currency: string } | null> {
  try {
    const data = await fwMerchant<{ status: string; amount: number; currency: string }>(
      secretKey,
      `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`,
      { method: "GET" },
      signal,
    );
    return { status: data.status, amount: data.amount, currency: data.currency };
  } catch {
    return null;
  }
}
