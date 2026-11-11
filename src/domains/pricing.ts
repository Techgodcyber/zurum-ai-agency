/**
 * Domain pricing. Founder's rule: add a 20% fee on top of the raw registrar
 * cost, and quote the customer the TOTAL (cost + fee) — never a separate line.
 * Applied per-domain to the LIVE registrar price, because TLDs differ wildly
 * (.com ≈ $11, .io ≈ $32), so a single flat price would over- or under-charge.
 */

export const MARGIN = 0.2; // 20% on top of cost

/** Customer's total price for a domain given the registrar's cost (USD/year). */
export function customerPrice(costUsd: number): number {
  const total = costUsd * (1 + MARGIN);
  // Round to cents; keep it a plain number so callers can format as they like.
  return Math.round(total * 100) / 100;
}

/** Format a USD amount the way we quote it to customers. */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** A ready-to-say price string, e.g. "$13.19/year". */
export function priceLabel(costUsd: number): string {
  return `${formatUsd(customerPrice(costUsd))}/year`;
}
