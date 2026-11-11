import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

/**
 * Flutterwave client — creates hosted-checkout payments and verifies them.
 *
 * The hosted checkout lets the customer pay by card, bank transfer or USSD on
 * Flutterwave's own page (so Nigerians get bank transfer without us building a
 * dedicated virtual account for the MVP). We verify by tx_ref when the customer
 * taps "I've paid", so no public webhook is required to credit the wallet — the
 * webhook is a later upgrade for hands-off / out-of-band transfers.
 */

const log = logger.child({ mod: "flutterwave" });

export function isFlutterwaveConfigured(): boolean {
  return Boolean(env.FLUTTERWAVE_SECRET_KEY);
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fw<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: string; message?: string; data: T }> {
  const res = await fetch(`${env.FLUTTERWAVE_BASE_URL}${path}`, {
    ...init,
    signal: withTimeout(signal, 30000),
    headers: {
      authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const json = (await res.json().catch(() => ({ status: "error" }))) as {
    status: string;
    message?: string;
    data: T;
  };
  if (!res.ok || json.status !== "success") {
    throw new Error(`flutterwave ${path} → ${res.status}: ${json.message ?? "error"}`);
  }
  return json;
}

/** Create a hosted-checkout payment. Returns the checkout link. */
export async function createPayment(args: {
  txRef: string;
  amount: number;
  currency: string;
  email: string;
  name: string;
  credits: number;
  signal?: AbortSignal;
}): Promise<{ link: string }> {
  const { data } = await fw<{ link: string }>(
    "/payments",
    {
      method: "POST",
      body: JSON.stringify({
        tx_ref: args.txRef,
        amount: args.amount,
        currency: args.currency,
        redirect_url: env.FLUTTERWAVE_REDIRECT_URL,
        customer: { email: args.email, name: args.name },
        customizations: {
          title: "Zurum Credits",
          description: `${args.credits} credits top-up`,
        },
        payment_options: "card,banktransfer,ussd,account",
      }),
    },
    args.signal,
  );
  log.info({ txRef: args.txRef, amount: args.amount, currency: args.currency }, "payment created");
  return { link: data.link };
}

export interface VerifiedPayment {
  status: string; // "successful" when paid
  amount: number;
  currency: string;
  txRef: string;
}

/** Verify a payment by our tx_ref (called when the customer taps "I've paid"). */
export async function verifyByReference(
  txRef: string,
  signal?: AbortSignal,
): Promise<VerifiedPayment | null> {
  try {
    const { data } = await fw<{
      status: string;
      amount: number;
      currency: string;
      tx_ref: string;
    }>(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`, { method: "GET" }, signal);
    return { status: data.status, amount: data.amount, currency: data.currency, txRef: data.tx_ref };
  } catch (err) {
    // No transaction yet (customer hasn't paid) surfaces as an error — treat as
    // "not found / not paid" rather than a hard failure.
    log.info({ txRef, err: (err as Error).message }, "verify: not paid yet / not found");
    return null;
  }
}
