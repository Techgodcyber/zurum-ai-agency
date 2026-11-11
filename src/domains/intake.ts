/**
 * Domain-request understanding. Actually *registering* domains isn't built yet
 * (no registrar integration), but the bot must never do what it did in early
 * testing — say "Got it!" and then forget. These pure helpers let the app
 * recognise a domain request, pull out the exact name, and answer honestly.
 */

// Common TLDs customers ask for (incl. a few African ccTLDs). Not exhaustive —
// just enough to recognise intent; the registrar will validate for real later.
const TLD =
  "(?:com|net|org|io|co|shop|store|online|site|app|dev|xyz|info|biz|me|africa|ng|com\\.ng|org\\.ng|uk|us|ca|de|fr|es|it|ng)";

const DOMAIN_RE = new RegExp(
  `\\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+${TLD})\\b`,
  "i",
);

const PURCHASE = /\b(buy|register|purchase|reserve|secure|get\s+me|i\s+want|i\s+need)\b/i;

/** The first real domain name in a message, or null. Ignores our own hosts. */
export function extractDomain(text: string): string | null {
  const m = text.match(DOMAIN_RE);
  if (!m) return null;
  const d = m[1]!.toLowerCase();
  // Never treat our own preview/hosting URLs as a domain the customer wants.
  if (/\.netlify\.app$/.test(d) || /\bzurum\./.test(d)) return null;
  return d;
}

/**
 * A domain purchase/registration request. Triggers when the word "domain" is
 * used, OR a purchase verb sits next to an actual domain name — so a passing
 * mention of some website ("add a link to google.com") is NOT mistaken for one.
 */
export function domainRequest(text: string): { domain: string | null } | null {
  const domain = extractDomain(text);
  const intent = /\bdomain\b/i.test(text) || (domain !== null && PURCHASE.test(text));
  return intent ? { domain } : null;
}

/** A follow-up about a domain we already captured ("where is the one I asked for?"). */
export function isDomainFollowup(text: string): boolean {
  return /\b(the one|told you|to buy|you bought|my domain|the domain|where.{0,20}domain)\b/i.test(
    text,
  );
}

/** Close alternative names to offer when the one they wanted is taken. */
export function suggestAlternatives(domain: string): string[] {
  const dot = domain.indexOf(".");
  const name = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot + 1) : "com";
  const alts = new Set<string>();
  for (const t of ["com", "org", "net", "co"]) if (t !== tld) alts.add(`${name}.${t}`);
  alts.add(`get${name}.${tld}`);
  alts.add(`${name}hq.${tld}`);
  return [...alts].slice(0, 4);
}

// NOTE: these return REAL customer-facing text (a draft the voice layer warms and
// translates), NOT instructions — if phrasing fails, the draft itself is shown.

/** The "get it for me" path when checkout isn't live yet. */
export function domainSavedMeaning(domain: string | null): string {
  return domain
    ? `Nice — I've saved ${domain} for you ✅ Buying domains is switching on very soon; when it's ready I'll register it in YOUR name (it stays yours, transferable anytime), with private details and https included, renewing yearly with a friendly reminder from me — never a surprise charge. Your website is already live on its current link in the meantime.`
    : `Sure — which domain would you like? (for example yourname.com) I can connect one you already own for free, or get you a brand-new one. Your site already has a free live link right now 😊`;
}

/** A domain is available — the price + the terms. */
export function domainQuoteMeaning(domain: string, priceLabel: string): string {
  return `Good news — ${domain} is available for ${priceLabel} 🎉 It's registered in your name and stays yours (transferable anytime), with private details and https included, and it renews yearly — I'll remind you before it expires, never an automatic charge — and it's non-refundable once registered. Checkout is switching on very soon; I've saved it and I'll secure it for you the moment it's ready.`;
}

/** The requested name is taken — offer alternatives. */
export function domainTakenMeaning(domain: string, alternatives: string[]): string {
  return `Ah, ${domain} is already taken 😕 But these are likely available — want one of them? ${alternatives.join(", ")}`;
}

/** When they chase a domain we've already saved. */
export function domainStatusMeaning(domain: string): string {
  return `I haven't forgotten — I've got ${domain} saved for you ✅ Buying isn't switched on just yet, so I can't complete it this moment, but I'll secure that exact name as soon as it's ready and let you know. Your website stays live on its current link in the meantime.`;
}
