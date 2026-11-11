import { env } from "../config/env.js";
import { getNum } from "../config/settings.js";

/**
 * Payment seam for credit top-ups. Paystack + Flutterwave both cover CARD and
 * BANK TRANSFER (so customers who won't touch a card can still pay); USDT covers
 * crypto. This module defines the packages and which rails are available; the
 * live provider calls (init transaction + webhook confirmation → credits.grant)
 * are wired once keys AND a public webhook exist. Until then top-ups are captured
 * honestly as "coming soon".
 */

export interface TopupPackage {
  usd: number;
  credits: number;
}

export type PayMethod = "card" | "bank" | "usdt";

/** Convert a USD amount to credits at the configured rate. */
export function creditsForUsd(usd: number): number {
  return Math.round(usd * getNum("credits_per_usd"));
}

/** Suggested top-up packages (min, 2×, 4×). */
export function topupPackages(): TopupPackage[] {
  const min = getNum("min_topup_usd");
  return [min, min * 2, min * 4].map((usd) => ({ usd, credits: creditsForUsd(usd) }));
}

/** Which payment rails are actually configured right now. */
export function availableMethods(): PayMethod[] {
  const methods: PayMethod[] = [];
  if (env.PAYSTACK_SECRET_KEY || env.FLUTTERWAVE_SECRET_KEY) methods.push("card", "bank");
  if (env.USDT_WALLET_ADDRESS) methods.push("usdt");
  return methods;
}

export function anyPaymentConfigured(): boolean {
  return availableMethods().length > 0;
}

/** A human list of the packages, e.g. "$5 → 50 credits · $10 → 100 credits". */
export function packagesLine(): string {
  return topupPackages()
    .map((p) => `$${p.usd} → ${p.credits} credits`)
    .join(" · ");
}

/**
 * Real customer-facing top-up message (a draft the voice layer warms/translates).
 * Shown alongside the tappable package buttons.
 */
export function topupOfferMeaning(): string {
  const packages = packagesLine();
  if (anyPaymentConfigured()) {
    return `Top up your credits to keep building and editing 💳\n${packages}\nYou can pay by card, bank transfer, or USDT — just tap a package below.`;
  }
  return `Here's how top-ups will work 💳\n${packages}\nPayable by card, bank transfer, or USDT. Paid top-ups are switching on very soon — tap a package below and I'll note your interest and message you the moment it's live. Your site stays live meanwhile.`;
}
