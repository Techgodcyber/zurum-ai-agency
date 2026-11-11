import { randomUUID } from "node:crypto";
import { logger } from "./lib/logger.js";
import { runScribe } from "./agents/scribe.js";
import { runAria } from "./agents/aria.js";
import { phrase } from "./agents/voice.js";
import { Maestro } from "./orchestrator/maestro.js";
import { getJob, failOrphanedJobs, sitesForChat, recentSiteIdsForChat, recentSiteIdsForUser, type Job } from "./db/jobs.js";
import { saveLogo } from "./media/logos.js";
import { readSite } from "./sites/store.js";
import { resolveSiteHtml, siteExists } from "./sites/resolve.js";
import { getHosting } from "./launch/hosting-store.js";
import { fetchBlueprint, blueprintToBrief } from "./media/webref.js";
import { resolveUserId, getUserCurrency, setUserCurrency } from "./users/store.js";
import { chatWidgetRequest } from "./config/embeds.js";
import {
  domainRequest,
  isDomainFollowup,
  domainSavedMeaning,
  domainStatusMeaning,
  domainQuoteMeaning,
  domainTakenMeaning,
  suggestAlternatives,
} from "./domains/intake.js";
import { recordDomainRequest } from "./domains/store.js";
import { connectExistingDomain } from "./domains/connect.js";
import { isNamesiloConfigured, checkAvailability } from "./domains/namesilo.js";
import { priceLabel } from "./domains/pricing.js";
import {
  parseCommand,
  isAdminIdentity,
  setUserLimit,
  usageFor,
  usageStats,
  editsUsed,
  splitIdentity,
} from "./billing/quota.js";
import {
  checkEditMeter,
  checkBuildMeter,
  applyEditCharge,
  applyBuildCharge,
  reverseEditCharge,
  reverseBuildCharge,
  isTopupRequest,
  isBalanceRequest,
  editBlockedMeaning,
  buildBlockedMeaning,
  lowCreditMeaning,
  walletCard,
  parseTransfer,
  isSitesCountQuestion,
  type Charge,
} from "./billing/metering.js";
import { topupOfferMeaning, topupPackages, creditsForUsd } from "./billing/payments.js";
import { grant, getBalance, spend } from "./billing/credits.js";
import { isFlutterwaveConfigured, createPayment, verifyByReference } from "./billing/flutterwave.js";
import { isFxConfigured, usdRate } from "./billing/fx.js";
import { createTopup, getTopup, markPaid } from "./billing/topups.js";
import { scoreTopup, recordFraudFlag } from "./billing/fraud.js";
import {
  isPublished,
  planFor,
  publishPriceUsd,
  createPublishOrder,
  getPublishOrder,
  markPublishOrderPaid,
  markPublished,
} from "./billing/publish.js";
import {
  getNum,
  setNum,
  isSettingKey,
  allSettings,
  labelOf,
} from "./config/settings.js";
import { env } from "./config/env.js";
import { describeImageForBuild, describeImageForEdit, canSeeImages } from "./media/vision.js";
import { splitDataUri } from "./media/gemini.js";
import { BASE_URL, previewUrlFor } from "./web/preview-server.js";
import { createPanelToken } from "./panel/tokens.js";
import { backendStats, listSiteUsers } from "./backend/store.js";
import { setPaymentConfig, addProduct, listProducts, listOrders, orderStats, getStoreInfo } from "./backend/commerce.js";
import { buildReport, formatReport, siteIdsForUser } from "./growth/report.js";
import { generateContent } from "./growth/content.js";
import { isTitanConfigured, provisionMailbox, dnsSteps } from "./email/titan.js";
import * as conv from "./conversations/store.js";
import type {
  Action,
  ChannelName,
  IncomingMessage,
  OutboundSender,
} from "./channels/types.js";

const log = logger.child({ mod: "app" });

/** Quick-action buttons shown at the approval gate. */
const APPROVAL_ACTIONS: Action[] = [
  { id: "approve", label: "✅ Publish it live" },
  { id: "request_change", label: "✏️ Request a change" },
];

// Last labels we should NOT treat as a website when the customer typed a bare
// "name.ext" with no scheme, no www and no path — these are filenames / libs,
// not sites (e.g. "default.php", "Node.js", "logo.png").
const NOT_A_TLD = new Set([
  "php", "html", "htm", "js", "ts", "jsx", "tsx", "css", "json", "png", "jpg",
  "jpeg", "gif", "svg", "webp", "pdf", "zip", "md", "txt", "xml", "yml", "yaml",
  "env", "sql", "exe", "doc", "docx",
]);

/**
 * A reference website the customer wants us to look at — accepts both a full
 * `https://…` link AND a bare domain like `mysite.com` or `www.shop.co/uk`,
 * because most people paste a site without typing the scheme. Returns null for
 * our own preview links, email addresses, and plain filenames.
 */
/**
 * "Open MY Zurum dashboard / download MY code" → the customer's own account
 * portal. Deliberately NARROW: it must be about the customer's OWN account
 * (possessive "my …"), and a BUILD/EDIT instruction is never a panel request —
 * "build me a dashboard / login page / admin page" are things to BUILD on a
 * site, not a request to open their Zurum account. (Regression fix: the old
 * pattern matched a bare "dashboard" and hijacked build requests.)
 */
export function isPanelRequest(text: string): boolean {
  const s = text.toLowerCase().trim();
  // A construction instruction is a BUILD, never a panel request — even if it
  // mentions dashboard/admin/account/login (those are site features to build).
  if (/\b(build|create|make|add|design|generate|develop|put|include|remove|delete|redesign)\b/.test(s)) {
    return false;
  }
  if (/\bpage\b/.test(s)) return false; // "login page", "admin page", "dashboard page"
  return (
    /\bmy (dashboard|account|profile|panel|portal)\b/.test(s) ||
    /\bmy control panel\b/.test(s) ||
    /\bcustomer (dashboard|portal)\b/.test(s) ||
    /\bmanage my (account|sites?)\b/.test(s) ||
    /\b(download|export)\b[^.!?]{0,24}\bmy\b[^.!?]{0,16}\b(code|site|website|files|source|data|customers?|orders?|leads?|submissions?)\b/.test(s) ||
    /\bown my data\b/.test(s)
  );
}

/** A pasted Flutterwave SECRET key (the merchant connecting their payouts). */
export function isFlutterwaveKey(text: string): boolean {
  return /^FLWSECK[-_]/i.test(text.trim());
}

/** "Connect / set up payments" — the merchant wants to take money on their site. */
export function isConnectPayment(text: string): boolean {
  const s = text.toLowerCase();
  return (
    /\b(connect|set ?up|setup|add|link|enable|accept|take|receive)\b[^.!?]{0,24}\b(payment|payments|flutterwave|checkout|cards?|sales?)\b/.test(s) ||
    /\b(sell|take orders?)\b[^.!?]{0,20}\b(online|on my (site|website|shop))\b/.test(s)
  );
}

/** "Add product Sneakers 25000" → {name, price}, or null. */
export function parseAddProduct(text: string): { name: string; price: number } | null {
  const m = /^\s*add\s+(?:a\s+)?(?:product|item)\s+(.+)$/i.exec(text);
  if (!m) return null;
  const rest = m[1]!.trim();
  const pm = /([\d][\d,]*(?:\.\d{1,2})?)\s*$/.exec(rest.replace(/[₦$€£]|ngn|usd|naira/gi, "").trim());
  if (!pm) return null;
  const price = Number(pm[1]!.replace(/,/g, ""));
  if (!price || price <= 0) return null;
  const name = rest.slice(0, rest.toLowerCase().lastIndexOf(pm[1]!.toLowerCase())).replace(/\b(for|at|@|-|price|costs?|:)\b\s*$/i, "").replace(/[₦$€£]/g, "").trim();
  if (!name) return null;
  return { name: name.slice(0, 120), price };
}

/** "Set up a business email / create support@mydomain" → Titan mailbox. */
export function isBusinessEmailRequest(text: string): boolean {
  const s = text.toLowerCase();
  return (
    /\b(business|company|professional|custom|work)\s+(e-?mail|mailbox)\b/.test(s) ||
    /\b(create|set ?up|setup|make|get me|i want|i need|give me)\b[^.!?]{0,26}\b(an? |my )?(e-?mail address|mailbox|business e-?mail)\b/.test(s) ||
    /\b(support|info|hello|admin|sales|contact|team|hi)@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i.test(s)
  );
}

/** Parse "create support@waterfactoryweb.com" or "email for waterfactoryweb.com". */
export function parseEmailRequest(text: string): { localPart: string; domain: string } | null {
  const email = /([a-z0-9][a-z0-9._-]*)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(text);
  if (email) return { localPart: email[1]!.toLowerCase(), domain: email[2]!.toLowerCase() };
  const dom = /\b([a-z0-9-]+\.(?:com|net|org|co|io|ng|com\.ng|co\.za|africa|shop|store|app|xyz)(?:\.[a-z]{2,})?)\b/i.exec(text);
  if (dom) return { localPart: "support", domain: dom[1]!.toLowerCase() };
  return null;
}

/** "Write me a blog post / captions / product description" → AI marketing copy. */
export function isContentRequest(text: string): boolean {
  const s = text.toLowerCase();
  return (
    /\b(write|generate|create|draft|compose|give me|make me)\b[^.!?]{0,40}\b(blog post|blog|article|captions?|tweets?|thread|ad copy|advert|advertisement|product description|meta description|newsletter|marketing (?:email|copy)|social(?: media)? post|instagram post|facebook post|linkedin post|copy for)\b/.test(s) ||
    /\b(captions?|blog post|product description|social post|ad copy|marketing copy)\b[^.!?]{0,24}\bfor\b/.test(s)
  );
}

/** "How's my site doing / my report / weekly stats" → the growth report. */
export function isReportRequest(text: string): boolean {
  const s = text.toLowerCase();
  return (
    /\bmy (report|stats|statistics|analytics|performance|numbers|traffic|visitors?)\b/.test(s) ||
    /\bhow('?s| is| are)\b[^.!?]{0,20}\b(my )?(site|website|business|shop|store|things?)\b[^.!?]{0,12}\bdoing\b/.test(s) ||
    /\b(how am i doing|weekly report|site report|growth report)\b/.test(s)
  );
}

/** "My sales / orders / how much have I made" → the merchant's store takings. */
export function isSalesQuestion(text: string): boolean {
  const s = text.toLowerCase();
  return (
    /\bmy (orders?|sales?|takings?|store)\b/.test(s) ||
    /\bhow much (have i|did i|i've)\b[^.!?]{0,20}\b(made|sold|earn|earned)\b/.test(s) ||
    /\b(sales|order)s? (report|today|so far)\b/.test(s)
  );
}

/** "How many signed up / who registered / my users" → the owner's signups view. */
export function isSignupsQuestion(text: string): boolean {
  const s = text.toLowerCase();
  return (
    /\b(sign[\s-]?ups?|signed[\s-]?up|registrations?|registered users?)\b/.test(s) ||
    /\b(who|how many)\b[^.!?]{0,20}\b(signed up|registered|members?|subscribers?)\b/.test(s) ||
    /\bmy (users|members|signups|subscribers)\b/.test(s) ||
    /\b(site|website) (users|members|signups)\b/.test(s)
  );
}

export function referenceUrl(text: string, ourBase: string): string | null {
  const base = ourBase.toLowerCase();

  // 1. Full URL with a scheme — take as-is.
  const withScheme = text.match(/https?:\/\/[^\s<>"']+/i);
  if (withScheme) {
    const url = withScheme[0].replace(/[).,]+$/, "");
    return url.toLowerCase().startsWith(base) ? null : url;
  }

  // 2. Scheme-less domain, e.g. "mysite.com", "www.shop.co.uk/pricing".
  const re = /(^|[\s(])((?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,24})(\/[^\s<>"']*)?/gi;
  for (const m of text.matchAll(re)) {
    const prefix = m[1] ?? "";
    // Skip email addresses ("name@example.com").
    if (prefix === "" && m.index! > 0 && text[m.index! - 1] === "@") continue;
    const idx = m.index! + prefix.length;
    if (idx > 0 && text[idx - 1] === "@") continue;

    const host = m[2]!;
    const path = m[3] ?? "";
    const tld = host.split(".").pop()!.toLowerCase();
    const hasStrongSignal = Boolean(path) || /^www\./i.test(host);
    if (!hasStrongSignal && NOT_A_TLD.has(tld)) continue; // filename, not a site

    const url = `https://${host}${path}`.replace(/[).,]+$/, "");
    if (url.toLowerCase().startsWith(base)) continue;
    return url;
  }
  return null;
}

/** Buttons asking who owns a reference site (decides exact vs inspired). */
const OWNERSHIP_ACTIONS: Action[] = [
  { id: "url_mine", label: "✅ It's my site" },
  { id: "url_inspire", label: "💡 Just inspiration" },
];

/** Buttons deciding whether a wanted domain is one they own or one to buy. */
const DOMAIN_ACTIONS: Action[] = [
  { id: "domain_own", label: "✅ I own it" },
  { id: "domain_buy", label: "🛒 Get it for me" },
];

/** Tappable top-up packages + a custom-amount option (payment UI on chat). */
function topupActions(): Action[] {
  return [
    ...topupPackages().map((p) => ({
      id: `topup_${p.usd}`,
      label: `💳 $${p.usd} → ${p.credits} credits`,
    })),
    { id: "topup_custom", label: "✏️ Other amount" },
  ];
}

/**
 * A non-instruction like "edit my site", "image", "change it" — too vague to act
 * on, so we ask for specifics instead of burning an edit on a garbage change.
 */
function isVagueEdit(change: string): boolean {
  const t = change
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/\s+(for me|please|pls|now|abeg)$/, "")
    .trim();
  if (t.length < 4) return true;
  if (
    /^(edit|change|update|fix|improve|modify|adjust|redo|redesign)( (it|this|my|the)( (site|website|web ?site|page|banking site))?)?$/.test(t)
  )
    return true;
  return /^(image|images|the image|picture|photo|photos|logo|colou?rs?|text|font|design)$/.test(t);
}

/** Format a charge amount for the customer (₦8,000 / $5). */
function formatAmount(amount: number, currency: string): string {
  if (currency === "NGN") return `₦${amount.toLocaleString("en-NG")}`;
  if (currency === "USD") return `$${amount}`;
  return `${amount} ${currency}`;
}

/** WhatsApp phone country-code → currency (only used when FX can price it). */
const PHONE_CURRENCY: [RegExp, string][] = [
  [/^\+?234/, "NGN"], // Nigeria
  [/^\+?233/, "GHS"], // Ghana
  [/^\+?254/, "KES"], // Kenya
  [/^\+?256/, "UGX"], // Uganda
  [/^\+?255/, "TZS"], // Tanzania
  [/^\+?27/, "ZAR"], // South Africa
  [/^\+?44/, "GBP"], // UK
  [/^\+?1\d/, "USD"], // US / Canada
];

/**
 * Infer a customer's currency from their channel identity. On WhatsApp the
 * identity IS the phone number → map the country code. Telegram/web give no
 * phone/location, so we return null and ask the customer once. Currencies other
 * than NGN/USD are only used when FX rates are available to price them.
 */
function currencyFromChannel(channel: string, from: string): string | null {
  if (channel !== "whatsapp") return null;
  let currency = "USD";
  for (const [re, cur] of PHONE_CURRENCY) {
    if (re.test(from)) {
      currency = cur;
      break;
    }
  }
  if (currency !== "NGN" && currency !== "USD" && !isFxConfigured()) return "USD";
  return currency;
}

/** Convert a USD package price into the charge amount for a currency. */
async function amountFor(usd: number, currency: string): Promise<number> {
  if (currency === "USD") return usd;
  if (currency === "NGN") return Math.round(usd * getNum("ngn_per_usd")); // founder-set rate
  const rate = await usdRate(currency);
  return rate ? Math.round(usd * rate) : usd; // fallback (shouldn't happen — currency is gated)
}

/** Detects a "send me my site link / where is my website" request (any phase). */
export function isLinkRequest(text: string): boolean {
  const t = text.toLowerCase();
  // "add/put a link ..." is an EDIT, not a request for their site URL.
  if (/\b(add|put|insert|include|place|embed)\b[^.]{0,20}\blink\b/.test(t)) return false;
  return (
    /(send|share|give|show|get|resend|see|need|want)\b.{0,25}\b(link|url|site|website|web ?site|page)\b/.test(t) ||
    /\bwhere\b.{0,20}\b(link|url|site|website|page|it)\b/.test(t) ||
    /\b(my|the)\b[^.]{0,15}\b(site|website|web ?site)\b[^.]{0,8}\b(link|url|address)\b/.test(t) ||
    /\b(site|website|web ?site)\s+link\b/.test(t) ||
    /^\s*(the |my )?link\s*\??$/.test(t)
  );
}

/**
 * A short factual summary of a generated site (title + headings) so Aria can
 * answer "tell me about my site" from reality instead of inventing details.
 */
function siteSummary(html: string): string {
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? "";
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((m) => m[1]!.replace(/<[^>]+>/g, "").trim())
    .filter((t) => t.length > 0 && t.length < 80)
    .slice(0, 12);
  return [
    title ? `Page title: ${title}` : "",
    headings.length ? `Sections/headings: ${headings.join(" · ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Last thing the customer said — used for language matching in phrased messages. */
function lastUserText(c: conv.Conversation | null): string {
  if (!c) return "";
  for (let i = c.messages.length - 1; i >= 0; i--) {
    if (c.messages[i]!.role === "user") return c.messages[i]!.content;
  }
  return "";
}

/**
 * Zurum application core. Intake runs Scribe; once a preview exists, every
 * message runs through Aria (edit / approve / chat) so the bot understands
 * intent in any language instead of mistaking "hello" for an edit. System
 * messages are phrased in the customer's language via the voice layer.
 */
export class ZurumApp {
  #maestro: Maestro;
  #sender: OutboundSender;

  constructor(sender: OutboundSender) {
    this.#sender = sender;
    this.#maestro = new Maestro({ notifier: this.#buildNotifier() });
  }

  start(): void {
    this.#maestro.start();
  }

  /** Reconcile jobs orphaned by a previous restart. Call once on boot. */
  async recoverOnBoot(): Promise<void> {
    const n = await failOrphanedJobs();
    if (n) log.warn({ jobs: n }, "reconciled orphaned in-flight jobs from previous run");
  }

  handleInbound = async (msg: IncomingMessage): Promise<void> => {
    let c = await conv.getOrCreate(msg.channel, msg.chatId);

    // Resolve the customer's identity (same person across channels) and bind the
    // conversation to it on first contact — the foundation for cross-channel
    // continuity, and for tying sites/approvals/payments to a real user later.
    if (!c.userId) {
      const userId = await resolveUserId(msg.channel, msg.from);
      await conv.setUser(c.id, userId);
      c = { ...c, userId };
    }

    // Self-heal the conversation's current site. It can be MISSING, or (worse)
    // point at a DEAD site — e.g. a build that failed after its id was assigned —
    // which silently breaks every edit and makes the bot claim "you have no site"
    // while the customer's real site is live. So we verify the site actually
    // exists and, if not, recover their most recent site that does.
    if (c.phase !== "building") {
      const valid = c.siteId ? await siteExists(c.siteId) : false;
      if (!valid) {
        // Prefer sites from THIS chat; then fall back to the user's sites across
        // ALL channels — so web chat (or a new channel) continues with the site
        // they built by WhatsApp number. Same person = same sites.
        const candidates = [
          ...(await recentSiteIdsForChat(msg.channel, msg.chatId)),
          ...(c.userId ? await recentSiteIdsForUser(c.userId) : []),
        ];
        for (const cand of candidates) {
          if (!(await siteExists(cand.siteId))) continue;
          await conv.setSite(c.id, cand.siteId);
          const phase = c.phase === "intake" ? "done" : c.phase;
          if (phase !== c.phase) await conv.setPhase(c.id, phase);
          log.info({ from: c.siteId ?? "none", to: cand.siteId }, "recovered conversation's site");
          c = { ...c, siteId: cand.siteId, phase };
          break;
        }
      }
    }

    // Control commands (/id, admin /limit, /quota) — handled before anything else.
    if (msg.text && msg.text.trim().startsWith("/")) {
      if (await this.#handleCommand(c, msg)) return;
    }

    // An uploaded image. Figure out the INTENT — recreate a design, point at
    // something to fix, or provide a logo — instead of assuming "logo".
    if (msg.image) {
      const caption = (msg.text ?? "").toLowerCase().trim();
      const wantsRebuild =
        /\b(build|rebuild|clone|copy|recreate|replicate|like this|same as|this design|from this|based on this|make.*look like|my dashboard|my site look)\b/.test(
          caption,
        );
      const wantsLogo =
        /\b(logo|brand mark|company logo|use (this|it) as (my |the )?logo|(here'?s |this is )?my logo|add (my |the )?logo)\b/.test(caption);
      // A screenshot pointing at something to CHANGE (very common: "fix this",
      // "the circled part", "remove this"). This must NOT become the logo.
      const isEditRef =
        Boolean(c.siteId) &&
        !wantsRebuild &&
        !wantsLogo &&
        /\b(fix|issue|issues|problem|wrong|broken|error|change|edit|remove|delete|move|resize|circle|circled|arrow|mark(ed)?|highlighted|here|this (part|place|section|area|spot|button|image|logo|text)|the (part|place|area|spot|circled|marked))\b/.test(
          caption,
        );

      if (wantsRebuild && canSeeImages()) {
        await this.#buildFromImage(c, msg);
        return;
      }
      if (isEditRef) {
        await this.#editFromImage(c, msg);
        return;
      }
      await saveLogo(msg.channel, msg.chatId, msg.image.dataUri);
      log.info({ chatId: msg.chatId }, "logo uploaded");
      if (c.siteId && c.phase !== "building") {
        // Applying the logo is an edit → metered like any other edit.
        const gate = await this.#editGate(c, msg);
        if (!gate.ok) return; // saved the logo; gate already explained credits
        const editJobId = await this.#maestro.submitEdit({
          description:
            "Use the customer's uploaded logo image prominently in the header/hero as the site logo",
          channel: msg.channel,
          chatId: msg.chatId,
          siteId: c.siteId,
          chargeMode: gate.mode,
        });
        await conv.setPhase(c.id, "building", editJobId);
        await this.#charge(c, msg, "edit", gate.mode);
        await this.#say(msg, "Got your logo! 🎨 Adding it to your site now — one moment.");
      } else {
        await this.#say(
          msg,
          "Got your logo! 🎨 I'll use it on your site. Tell me what kind of website you'd like.",
        );
      }
      return;
    }

    // Answering the "is this your site?" question for a reference URL.
    if (
      (msg.text === "url_mine" || msg.text === "url_inspire") &&
      c.pendingUrl
    ) {
      await this.#buildFromReference(c, msg, c.pendingUrl, msg.text === "url_mine");
      return;
    }

    // A reference website link → ask who owns it (decides exact vs inspired).
    const ref = referenceUrl(msg.text, BASE_URL);
    if (ref) {
      await conv.setPendingUrl(c.id, ref);
      const text = await phrase(
        "Nice — I can work from that site. Quick question: is that your own website, or should I just use it as inspiration?",
        msg.text,
      );
      await this.#sender.sendActions(msg.channel, msg.chatId, text, OWNERSHIP_ACTIONS);
      return;
    }

    // Asked for a named live-chat widget but gave no ID → guide them to it,
    // rather than silently falling back to the WhatsApp button.
    const widget = chatWidgetRequest(msg.text);
    if (widget) {
      const intro = await phrase(
        `Sure! To add ${widget.name} chat I just need your widget ID. Here's where to find it:`,
        msg.text,
      );
      await this.#reply(
        msg.channel,
        msg.chatId,
        `${intro}\n\n${widget.steps}\n\nThen send it to me like: "${widget.name} ID: xxxxx"\n\n` +
          `(Or if you'd rather skip the signup, just say "use WhatsApp chat" and I'll add a WhatsApp chat button instead.)`,
      );
      return;
    }

    // Answering the "do you own it or should I buy it?" question for a domain.
    if (
      (msg.text === "domain_own" || msg.text === "domain_buy") &&
      c.pendingDomain
    ) {
      await this.#handleDomainChoice(c, msg, c.pendingDomain, msg.text === "domain_own");
      return;
    }

    // A domain request. Registration/checkout isn't switched on yet, but we NEVER
    // pretend or forget — capture the exact name, log it for fulfilment, and ask
    // whether they already own it (free connect) or want us to get it.
    const domReq = domainRequest(msg.text);
    if (domReq) {
      if (domReq.domain) {
        await conv.setPendingDomain(c.id, domReq.domain);
        if (c.userId) {
          try {
            await recordDomainRequest(c.userId, domReq.domain);
          } catch (err) {
            log.warn({ err }, "recordDomainRequest failed (non-fatal)");
          }
        }
        const ask = await phrase(
          `Nice choice — ${domReq.domain}. Quick question so I set it up right: do you already own this domain, or should I get it for you?`,
          msg.text,
        );
        await this.#sender.sendActions(msg.channel, msg.chatId, ask, DOMAIN_ACTIONS);
      } else {
        // They want a domain but haven't named one yet.
        await this.#reply(msg.channel, msg.chatId, await phrase(domainSavedMeaning(null), msg.text));
      }
      return;
    }

    // Chasing a domain we already captured ("where is the one I told you to buy?").
    if (c.pendingDomain && isDomainFollowup(msg.text)) {
      await this.#reply(
        msg.channel,
        msg.chatId,
        await phrase(domainStatusMeaning(c.pendingDomain), msg.text),
      );
      return;
    }

    // "How many websites can I build?" — answer with real numbers.
    if (isSitesCountQuestion(msg.text) && c.userId) {
      await this.#handleSitesQuestion(c, msg);
      return;
    }

    // "How many credits do I have?" — show the wallet card from any phase.
    if (isBalanceRequest(msg.text) && c.userId) {
      await this.#sendWallet(c, msg);
      return;
    }

    // "My dashboard / download my code" — send a private magic link to the panel.
    if (isPanelRequest(msg.text)) {
      await this.#sendPanelLink(c, msg);
      return;
    }

    // "How many signed up / who registered" — the site owner's real member count.
    if (isSignupsQuestion(msg.text) && c.userId) {
      await this.#handleSignupsQuestion(c, msg);
      return;
    }

    // A pasted Flutterwave key connects the merchant's store payouts. Handled
    // BEFORE history is appended so the secret key is never stored in the chat log.
    if (isFlutterwaveKey(msg.text)) {
      await this.#handlePaymentKey(c, msg);
      return;
    }
    if (isConnectPayment(msg.text)) {
      await this.#handleConnectPayment(c, msg);
      return;
    }
    const product = parseAddProduct(msg.text);
    if (product) {
      await this.#handleAddProduct(c, msg, product);
      return;
    }
    if (isSalesQuestion(msg.text) && c.userId) {
      await this.#handleSales(c, msg);
      return;
    }
    if (isReportRequest(msg.text) && c.userId) {
      await this.#handleReport(c, msg);
      return;
    }
    if (isBusinessEmailRequest(msg.text) && c.userId) {
      await this.#handleBusinessEmail(c, msg);
      return;
    }
    if (isContentRequest(msg.text) && c.userId) {
      await this.#handleContent(c, msg);
      return;
    }

    // Tapped a top-up package button.
    if (/^topup_\d+$/.test(msg.text)) {
      if (c.awaitingTopup) await conv.setAwaitingTopup(c.id, false);
      await this.#handleTopupTap(c, msg, Number(msg.text.slice("topup_".length)));
      return;
    }

    // Tapped a currency choice (cur_NGN_5 / cur_USD_10) — remember it + pay.
    const cur = msg.text.match(/^cur_(NGN|USD)_(\d+)$/);
    if (cur) {
      if (c.userId) await setUserCurrency(c.userId, cur[1]!);
      await this.#createTopupPayment(c, msg, Number(cur[2]), cur[1]!);
      return;
    }

    // Tapped "✏️ Other amount" — ask them to type any amount.
    if (msg.text === "topup_custom") {
      await conv.setAwaitingTopup(c.id, true);
      await this.#reply(
        msg.channel,
        msg.chatId,
        `How much would you like to top up? Just type the amount in US dollars (minimum $${env.MIN_TOPUP_USD}) — for example: 50`,
      );
      return;
    }

    // Waiting for a typed custom amount → parse it into a payment. (Ignore button
    // callbacks like paid_/topup_/url_/domain_ so their embedded digits aren't
    // mistaken for an amount.)
    if (c.awaitingTopup && !/^(paid_|pubpaid_|pubcur_|topup_|url_|domain_)/.test(msg.text)) {
      const m = msg.text.replace(/[,$]/g, "").match(/\d+(\.\d+)?/);
      const usd = m ? Math.floor(Number(m[0])) : NaN;
      if (Number.isFinite(usd) && usd >= env.MIN_TOPUP_USD && usd <= 100000) {
        await conv.setAwaitingTopup(c.id, false);
        await this.#handleTopupTap(c, msg, usd);
        return;
      }
      if (Number.isFinite(usd) && usd < env.MIN_TOPUP_USD) {
        await this.#reply(msg.channel, msg.chatId, `The minimum top-up is $${env.MIN_TOPUP_USD}. Please type $${env.MIN_TOPUP_USD} or more.`);
        return;
      }
      // Not an amount → they changed their mind; clear the flag and continue.
      await conv.setAwaitingTopup(c.id, false);
    }

    // Tapped "I've paid" after a payment — verify and credit.
    if (msg.text.startsWith("paid_")) {
      await this.#handlePaidTap(c, msg, msg.text.slice("paid_".length));
      return;
    }

    // Publish payment: currency choice, then "I've paid".
    if (msg.text === "pubcur_NGN" || msg.text === "pubcur_USD") {
      const currency = msg.text.slice("pubcur_".length);
      if (c.userId) await setUserCurrency(c.userId, currency);
      await this.#createPublishPayment(c, msg, currency);
      return;
    }
    if (msg.text.startsWith("pubpaid_")) {
      await this.#handlePublishPaidTap(c, msg, msg.text.slice("pubpaid_".length));
      return;
    }

    // "Send 20 credits to <friend>" — transfer credits to another customer.
    const transfer = parseTransfer(msg.text);
    if (transfer && c.userId) {
      await this.#handleTransfer(c, msg, transfer.amount, transfer.recipient);
      return;
    }

    // "I want to buy credits / top up" — present packages as tappable buttons.
    if (isTopupRequest(msg.text)) {
      await this.#sendTopupOffer(msg);
      return;
    }

    // "Send me my site link" — send the ACTUAL current-site URL (deterministic).
    if (isLinkRequest(msg.text)) {
      await this.#sendSiteLink(c, msg);
      return;
    }

    // "Building" — but only if the job is REALLY still running. If it was
    // orphaned by a restart, failed, or already finished, self-heal to the
    // right phase so the conversation is never permanently stuck.
    if (c.phase === "building") {
      const job = c.jobId ? await getJob(c.jobId) : null;
      if (job && (job.state === "running" || job.state === "queued")) {
        await this.#say(
          msg,
          "Still working on it — this usually takes under a minute. If it doesn't finish shortly, I'll tell you right away so you're never left waiting.",
        );
        return;
      }
      await this.#recoverStuck(c, job);
      c = await conv.getOrCreate(msg.channel, msg.chatId); // reload corrected phase
    }

    if (c.phase === "awaiting_approval" || c.phase === "done") {
      await this.#handlePostPreview(c, msg);
      return;
    }
    await this.#handleIntake(c, msg);
  };

  /** Move a stuck "building" conversation to the phase its job actually reached. */
  async #recoverStuck(c: conv.Conversation, job: Job | null): Promise<void> {
    let phase: conv.ConversationPhase;
    if (job?.state === "completed") phase = "done";
    else if (job?.state === "awaiting_approval") phase = "awaiting_approval";
    // failed / missing / orphaned: if a good site exists, return to its preview;
    // otherwise start intake fresh.
    else phase = c.siteId ? "awaiting_approval" : "intake";
    await conv.setPhase(c.id, phase);
    log.info({ conv: c.id, from: job?.state ?? "missing", to: phase }, "recovered stuck conversation");
  }

  /** Intake: Scribe converses naturally in the customer's language. */
  async #handleIntake(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    await conv.appendMessage(c.id, "user", msg.text);
    const history = [...c.messages, { role: "user" as const, content: msg.text }];
    const result = await runScribe(history);

    if (result.done && result.spec) {
      const gate = await this.#buildGate(c, msg);
      if (!gate.ok) return; // over quota — the gate already replied
      const siteId = randomUUID();
      const jobId = await this.#maestro.submit({
        description: result.spec,
        channel: msg.channel,
        chatId: msg.chatId,
        siteId,
        chargeMode: gate.mode,
      });
      await conv.setPhase(c.id, "building", jobId);
      await this.#charge(c, msg, "build", gate.mode);
      log.info({ jobId, siteId, channel: msg.channel }, "intake → build submitted");
      const reply = await phrase(
        "Perfect — I've got everything I need. I'm building your preview now and I'll send you the link shortly! 🛠️",
        msg.text,
      );
      await conv.appendMessage(c.id, "assistant", reply);
      await this.#reply(msg.channel, msg.chatId, reply);
      return;
    }

    await conv.appendMessage(c.id, "assistant", result.reply);
    await this.#reply(msg.channel, msg.chatId, result.reply);
  }

  /** Preview exists: buttons handled explicitly, everything else via Aria. */
  async #handlePostPreview(
    c: conv.Conversation,
    msg: IncomingMessage,
  ): Promise<void> {
    const text = msg.text.trim();

    // Tapped buttons (awaiting_approval only). Publishing is the paid annual
    // fee (host + domain) — #handlePublish gates it, except for admins / already
    // published sites.
    if (text === "approve") {
      await this.#handlePublish(c, msg);
      return;
    }
    if (text === "request_change") {
      await this.#say(
        msg,
        'Sure! Just tell me what to change — like "make the background green" or "add a booking section".',
      );
      return;
    }

    // Free text → Aria decides: edit / new / approve / chat, replies in-language.
    // Aria sees only the latest message (structured classification is unreliable
    // when fast models are fed chat history).
    await conv.appendMessage(c.id, "user", msg.text);
    // Give Aria the real facts of the current site AND the wallet, so it answers
    // truthfully instead of inventing billing/plan info or forgetting the site.
    // Resolve from local OR the live URL so a missing local copy never makes Aria
    // wrongly claim "you have no site".
    const currentHtml = c.siteId ? await resolveSiteHtml(c.siteId) : null;
    const wallet = c.userId ? await this.#walletFacts(c.userId, msg.channel, msg.from) : null;
    const aria = await runAria(msg.text, currentHtml ? siteSummary(currentHtml) : null, wallet);

    // A brand-new site (or an "edit" with nothing to edit yet) → a build. Gate
    // BEFORE replying so we don't say "sure!" then refuse for lack of credits.
    const isNewBuild = aria.action === "new" || (aria.action === "edit" && !c.siteId);
    if (isNewBuild) {
      const gate = await this.#buildGate(c, msg);
      if (!gate.ok) return; // over quota/credits — the gate already replied
      await conv.appendMessage(c.id, "assistant", aria.reply);
      await this.#reply(msg.channel, msg.chatId, aria.reply);
      const siteId = randomUUID();
      const jobId = await this.#maestro.submit({
        description: aria.change ?? msg.text,
        channel: msg.channel,
        chatId: msg.chatId,
        siteId,
        chargeMode: gate.mode,
      });
      await conv.setPhase(c.id, "building", jobId);
      await this.#charge(c, msg, "build", gate.mode);
      log.info({ jobId, siteId }, "aria → new build submitted");
      return;
    }

    // An edit of the existing site → metered (free edits, then credits). Gate
    // before replying too, for the same reason.
    if (aria.action === "edit" && c.siteId) {
      // A vague "edit it"/"image" isn't a real instruction — ask for specifics
      // instead of wasting an edit (and producing a bad change).
      if (isVagueEdit(aria.change ?? msg.text)) {
        await this.#reply(
          msg.channel,
          msg.chatId,
          await phrase(
            'Sure — what would you like me to change? For example: "make the header blue", "add a contact section", or "change the hero image".',
            msg.text,
          ),
        );
        return;
      }
      const gate = await this.#editGate(c, msg);
      if (!gate.ok) return; // out of free edits + credits — the gate already replied
      await conv.appendMessage(c.id, "assistant", aria.reply);
      await this.#reply(msg.channel, msg.chatId, aria.reply);
      const editJobId = await this.#maestro.submitEdit({
        description: aria.change ?? msg.text,
        channel: msg.channel,
        chatId: msg.chatId,
        siteId: c.siteId,
        chargeMode: gate.mode,
      });
      await conv.setPhase(c.id, "building", editJobId);
      await this.#charge(c, msg, "edit", gate.mode);
      log.info({ editJobId, siteId: c.siteId }, "aria → edit submitted");
      return;
    }

    // Link → send the REAL URL deterministically, NOT Aria's "it's attached
    // separately" narration (which lies when no URL is actually attached).
    if (aria.action === "link") {
      await this.#sendSiteLink(c, msg);
      return;
    }

    // Approve intent → the paid publish gate handles all messaging.
    if (aria.action === "approve") {
      await this.#handlePublish(c, msg);
      return;
    }

    await conv.appendMessage(c.id, "assistant", aria.reply);
    await this.#reply(msg.channel, msg.chatId, aria.reply);
    // chat: nothing further — phase stays as-is.
  }

  /**
   * The customer said whether they own the pending domain. Own → connect it to
   * their live site (free, Netlify handles SSL). Buy → check availability + quote
   * (when the registrar is configured) or capture it honestly.
   */
  async #handleDomainChoice(
    c: conv.Conversation,
    msg: IncomingMessage,
    domain: string,
    ownsIt: boolean,
  ): Promise<void> {
    if (!ownsIt) {
      await this.#handleDomainBuy(c, msg, domain);
      return;
    }
    // Connect a domain they already own.
    if (!c.siteId) {
      await this.#say(
        msg,
        "Let's finish and publish your website first — then I'll connect your domain to it in one step. Want me to build it now?",
      );
      return;
    }
    try {
      const res = await connectExistingDomain(c.siteId, domain);
      await conv.setPendingDomain(c.id, null);
      const intro = await phrase(
        `Perfect — I've linked ${domain} to your site. Here's the one-time setup to finish it 👇`,
        msg.text,
      );
      await this.#reply(msg.channel, msg.chatId, `${intro}\n\n${res.instructions}`);
    } catch (err) {
      if (err instanceof Error && err.message === "site-not-deployed") {
        await this.#say(
          msg,
          "Let's publish your website first, then I'll connect your domain to it — it only takes a moment. Ready to publish?",
        );
        return;
      }
      log.error({ err, domain }, "connect domain failed");
      await this.#say(
        msg,
        "I hit a snag linking that domain — let's try again in a moment, or tell me the domain once more.",
      );
    }
  }

  /** "Get it for me": availability + price quote when the registrar is live. */
  async #handleDomainBuy(
    c: conv.Conversation,
    msg: IncomingMessage,
    domain: string,
  ): Promise<void> {
    if (!isNamesiloConfigured()) {
      // Registrar not wired yet — be honest, we've already saved the request.
      await this.#reply(msg.channel, msg.chatId, await phrase(domainSavedMeaning(domain), msg.text));
      return;
    }
    try {
      const a = await checkAvailability(domain);
      if (a.status === "available") {
        const label = a.cost != null ? priceLabel(a.cost) : "a low yearly price";
        await this.#reply(msg.channel, msg.chatId, await phrase(domainQuoteMeaning(domain, label), msg.text));
      } else if (a.status === "taken") {
        const alts = suggestAlternatives(domain);
        await this.#reply(msg.channel, msg.chatId, await phrase(domainTakenMeaning(domain, alts), msg.text));
      } else {
        await this.#reply(
          msg.channel,
          msg.chatId,
          await phrase(
            `Explain gently that "${domain}" doesn't look like a valid domain name, and ask them to double-check the spelling (for example theirname.com).`,
            msg.text,
          ),
        );
      }
    } catch (err) {
      log.warn({ err, domain }, "availability check failed — capturing honestly");
      await this.#reply(msg.channel, msg.chatId, await phrase(domainSavedMeaning(domain), msg.text));
    }
  }

  /**
   * In-chat control panel. `/id` (anyone) shows their identity + usage; `/limit`
   * and `/quota` (admins only, from ADMIN_IDENTITIES) manage per-customer caps.
   * Returns true if the message was a command we handled.
   */
  async #handleCommand(c: conv.Conversation, msg: IncomingMessage): Promise<boolean> {
    const cmd = parseCommand(msg.text);
    if (!cmd) return false;

    if (cmd.kind === "id") {
      const identity = `${msg.channel}:${msg.from}`;
      const u = c.userId ? await usageFor(c.userId) : { used: 0, limit: null as number | null };
      log.info({ identity }, "/id requested");
      const of = u.limit === null ? "" : ` of ${u.limit}`;
      await this.#reply(msg.channel, msg.chatId, `Your Zurum ID: ${identity}\nWebsites built: ${u.used}${of}`);
      return true;
    }

    if (cmd.kind === "balance") {
      await this.#sendWallet(c, msg);
      return true;
    }

    // Everything below is admin-only.
    if (!isAdminIdentity(msg.channel, msg.from)) {
      await this.#reply(msg.channel, msg.chatId, "That command is for admins only.");
      return true;
    }

    // Control center: view / change limits + pricing live (no restart).
    if (cmd.kind === "config") {
      const lines = allSettings().map((s) => `• ${s.key} = ${s.value}  (${s.label})`);
      await this.#reply(
        msg.channel,
        msg.chatId,
        `⚙️ Control center — current settings:\n${lines.join("\n")}\n\nChange with:  /set <key> <value>`,
      );
      return true;
    }
    if (cmd.kind === "set") {
      if (!isSettingKey(cmd.key)) {
        const keys = allSettings().map((s) => s.key).join(", ");
        await this.#reply(msg.channel, msg.chatId, `Unknown setting "${cmd.key}". Valid: ${keys}`);
        return true;
      }
      await setNum(cmd.key, cmd.value);
      await this.#reply(
        msg.channel,
        msg.chatId,
        `✅ ${cmd.key} is now ${cmd.value} (${labelOf(cmd.key)}). Applies to everyone immediately.`,
      );
      return true;
    }

    const target = splitIdentity(cmd.target);
    if (!target) {
      await this.#reply(msg.channel, msg.chatId, "Use an identity like telegram:12345.");
      return true;
    }
    const targetUserId = await resolveUserId(target.channel, target.externalId);

    if (cmd.kind === "quota") {
      const u = await usageFor(targetUserId);
      const of = u.limit === null ? " (unlimited)" : ` of ${u.limit}`;
      const ov =
        u.override == null ? "" : ` [override: ${u.override === -1 ? "unlimited" : u.override}]`;
      await this.#reply(msg.channel, msg.chatId, `${cmd.target} → built ${u.used}${of}${ov}`);
      return true;
    }

    if (cmd.kind === "grant") {
      const balance = await grant(targetUserId, cmd.value, `admin grant to ${cmd.target}`, { resetRef: true });
      await this.#reply(
        msg.channel,
        msg.chatId,
        `Granted ${cmd.value} credits to ${cmd.target}. New balance: ${balance}.`,
      );
      return true;
    }

    // cmd.kind === "limit"
    const value = cmd.value === "unlimited" ? -1 : cmd.value === "default" ? null : cmd.value;
    await setUserLimit(targetUserId, value);
    await this.#reply(msg.channel, msg.chatId, `Done — ${cmd.target} build limit set to ${cmd.value}.`);
    return true;
  }

  /**
   * Apply a build/edit charge and, if it dropped the customer to a low balance,
   * send a one-time heads-up with top-up buttons so they're never cut off unaware.
   */
  async #charge(
    c: conv.Conversation,
    msg: IncomingMessage,
    kind: "edit" | "build",
    mode: Charge,
  ): Promise<void> {
    if (mode === "exempt" || !c.userId) return;
    const res =
      kind === "edit"
        ? await applyEditCharge(c.userId, mode)
        : await applyBuildCharge(c.userId, mode);
    if (res.lowWarning) {
      await this.#sender.sendActions(
        msg.channel,
        msg.chatId,
        await phrase(lowCreditMeaning(res.balance, getNum("min_topup_usd")), msg.text),
        topupActions(),
      );
    }
  }

  /** Resolve a transfer recipient: "telegram:123" / a WhatsApp phone. */
  #resolveRecipient(raw: string): { channel: string; externalId: string } | null {
    const id = raw.trim().match(/^(telegram|whatsapp|web):(.+)$/i);
    if (id) return { channel: id[1]!.toLowerCase(), externalId: id[2]!.trim() };
    const digits = raw.replace(/[^\d]/g, "");
    if (digits.length >= 10) {
      // Assume a phone → WhatsApp. A leading 0 is treated as a Nigerian local number.
      const phone = digits.startsWith("0") ? `234${digits.slice(1)}` : digits;
      return { channel: "whatsapp", externalId: phone };
    }
    return null;
  }

  /** Transfer credits from this customer to a friend (by phone or Zurum ID). */
  async #handleTransfer(
    c: conv.Conversation,
    msg: IncomingMessage,
    amount: number,
    recipientRaw: string,
  ): Promise<void> {
    if (!c.userId) return;
    const recip = this.#resolveRecipient(recipientRaw);
    if (!recip) {
      await this.#reply(
        msg.channel,
        msg.chatId,
        'I couldn\'t recognise that recipient. Use their WhatsApp number (e.g. 2348012345678) or their Zurum ID (e.g. telegram:12345 — they can get it by typing /id).',
      );
      return;
    }
    const recipientUserId = await resolveUserId(recip.channel, recip.externalId);
    if (recipientUserId === c.userId) {
      await this.#reply(msg.channel, msg.chatId, "You can't send credits to yourself 😄");
      return;
    }
    const balance = await getBalance(c.userId);
    if (balance < amount) {
      await this.#reply(
        msg.channel,
        msg.chatId,
        `You have ${balance} credit${balance === 1 ? "" : "s"} — not enough to send ${amount}. Top up first, or send a smaller amount.`,
      );
      return;
    }
    const spent = await spend(c.userId, amount, `transfer to ${recip.channel}:${recip.externalId}`);
    if (!spent.ok) {
      await this.#reply(msg.channel, msg.chatId, "That transfer didn't go through — please try again.");
      return;
    }
    const rbal = await grant(recipientUserId, amount, `transfer from ${msg.channel}:${msg.from}`);
    await this.#reply(
      msg.channel,
      msg.chatId,
      `✅ Sent ${amount} credit${amount === 1 ? "" : "s"} to ${recipientRaw}. Your balance is now ${spent.balance}.`,
    );
    // Best-effort notify the recipient (may fail if they haven't messaged us yet).
    try {
      await this.#sender.send(
        recip.channel as ChannelName,
        recip.externalId,
        `🎁 You just received ${amount} credit${amount === 1 ? "" : "s"} from a friend on Zurum! Your balance is now ${rbal}. Type "balance" to see your wallet.`,
      );
    } catch (err) {
      log.warn({ err }, "recipient notify failed (they may not have started the bot)");
    }
  }

  /**
   * Answer "how many websites…" — both how many they've BUILT (from real completed
   * sites) and how many they CAN build (free sites + credits). Always truthful.
   */
  async #handleSitesQuestion(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    if (!c.userId) return;
    const [m, stats, urls] = await Promise.all([
      checkBuildMeter(c.userId, msg.channel, msg.from),
      usageStats(c.userId),
      sitesForChat(msg.channel, msg.chatId),
    ]);
    // How many they've already built.
    const built = Math.max(stats.buildsUsed, urls.length);
    const builtLine =
      built > 0
        ? `You've built ${built} website${built === 1 ? "" : "s"} so far${urls.length ? `:\n${urls.join("\n")}` : "."}`
        : "You haven't built any websites yet.";
    // How many more they can build.
    if (m.mode === "exempt") {
      await this.#reply(msg.channel, msg.chatId, `${builtLine}\n\nYour account can build unlimited websites 🎉`);
      return;
    }
    const freeLeft = Number.isFinite(m.freeLeft) ? m.freeLeft : 0;
    const fromCredits = Math.floor(m.balance / m.cost);
    const canBuild = freeLeft + fromCredits;
    const canLine =
      canBuild > 0
        ? `You can build ${canBuild} more right now (${[
            freeLeft > 0 ? `${freeLeft} free` : "",
            fromCredits > 0 ? `${fromCredits} with your ${m.balance} credits` : "",
          ]
            .filter(Boolean)
            .join(" + ")}). Each new site is ${m.cost} credits after your free ones. Want to build one? 😊`
        : `You have ${m.balance} credits — a new site costs ${m.cost} credits, so top up to build more 👇`;
    if (canBuild > 0) {
      await this.#reply(msg.channel, msg.chatId, `${builtLine}\n\n${canLine}`);
    } else {
      await this.#sender.sendActions(msg.channel, msg.chatId, `${builtLine}\n\n${canLine}`, topupActions());
    }
  }

  /**
   * Send the customer their site's REAL live link — deterministically, never via
   * the AI (which would promise a URL it can't attach). Uses the hosting record
   * for the current site as the source of truth; falls back to the job checkpoint,
   * then the local preview, then any older sites, then an honest "no site yet".
   */
  async #sendSiteLink(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    const urls = await sitesForChat(msg.channel, msg.chatId);

    // 1. If they named a site ("spa", "bank"), match it against the URL slugs
    //    (the slug contains the business name) and send that exact one.
    if (urls.length > 1) {
      const stop = new Set([
        "the", "link", "site", "sites", "website", "websites", "send", "give", "show", "just",
        "please", "url", "for", "and", "get", "see", "where", "www", "https", "http", "com", "my",
        "pages", "dev", "netlify", "app", "zurum",
      ]);
      const keys = (msg.text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !stop.has(w));
      const matched = urls.find((u) => keys.some((k) => u.toLowerCase().includes(k)));
      if (matched) {
        await this.#reply(msg.channel, msg.chatId, `Here's your website 👇\n${matched}`);
        return;
      }
    }

    // 2. The current site's real URL (hosting record is the source of truth).
    if (c.siteId) {
      let url = (await getHosting(c.siteId))?.publicUrl;
      if (!url) {
        const job = c.jobId ? await getJob(c.jobId) : null;
        url =
          (job?.checkpoint.data["deployedUrl"] as string | undefined) ??
          (job?.checkpoint.data["previewUrl"] as string | undefined);
      }
      if (!url && (await readSite(c.siteId))) url = previewUrlFor(c.siteId);
      if (url) {
        await this.#reply(msg.channel, msg.chatId, `Here's your website 👇\n${url}`);
        return;
      }
    }

    // 3. Fallbacks: a single site, all sites, or honest "none yet".
    if (urls.length === 1) {
      await this.#reply(msg.channel, msg.chatId, `Here's your website 👇\n${urls[0]}`);
    } else if (urls.length) {
      await this.#reply(msg.channel, msg.chatId, `Here are your websites 👇\n${urls.join("\n")}`);
    } else {
      await this.#say(msg, "You don't have a website yet — tell me what you'd like and I'll build it for you! 😊");
    }
  }

  /** Real wallet facts for Aria's context so it answers credit questions truthfully. */
  async #walletFacts(userId: string, channel: string, from: string): Promise<string> {
    const m = await checkBuildMeter(userId, channel, from);
    if (m.mode === "exempt") return "This is an ADMIN account: unlimited edits and websites.";
    const freeEdits = Math.max(getNum("free_edit_limit") - (await editsUsed(userId)), 0);
    const freeSites = Number.isFinite(m.freeLeft) ? m.freeLeft : 0;
    const fromCredits = Math.floor(m.balance / m.cost);
    const totalSites = freeSites + fromCredits;
    return [
      `- Credits: ${m.balance}`,
      `- Free edits left: ${freeEdits} (edits are free until these run out, then ${getNum("edit_cost_credits")} credit each)`,
      `- Free websites left: ${freeSites} (new sites are free until these run out, then ${m.cost} credits each)`,
      `- Websites they can build RIGHT NOW: ${totalSites} (${freeSites} free + ${fromCredits} paid with their ${m.balance} credits)`,
      `- Top up: $5 = ${creditsForUsd(5)} credits (payable by card, bank transfer or USSD). To buy, they say "buy credits".`,
    ].join("\n");
  }

  /** Show the visual wallet card (credits + free-usage bars) with top-up buttons. */
  /** "Set up my business email" → provision a Titan mailbox on their domain. */
  async #handleBusinessEmail(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    if (!isTitanConfigured()) {
      await this.#say(
        msg,
        "Business email (like support@yourbrand.com) is almost here — I'm just finishing setting up our email service. I'll let you know the moment it's live! 📧",
      );
      return;
    }
    const parsed = parseEmailRequest(msg.text);
    if (!parsed) {
      await this.#reply(
        msg.channel,
        msg.chatId,
        'Sure! What address would you like? Tell me like this: *"create support@yourbrand.com"* (use a domain you own or that I set up for you).',
      );
      return;
    }
    try {
      const r = await provisionMailbox(parsed.domain, parsed.localPart, {
        customerId: c.userId ?? `${msg.channel}:${msg.from}`,
        userId: c.userId,
      });
      if ("status" in r && r.status === "not_configured") {
        await this.#say(msg, "Business email is almost ready — I'll let you know when it's live! 📧");
        return;
      }
      if ("status" in r && r.status === "exists") {
        await this.#reply(msg.channel, msg.chatId, `📧 *${r.email}* already exists on your account. Log in at https://mail.titan.email`);
        return;
      }
      const m = r as { email: string; password: string; webmailUrl: string; dns: { type: string; name: string; value: string; priority?: number }[] };
      await this.#reply(
        msg.channel,
        msg.chatId,
        `✅ Your business email is ready!\n\n📧 *${m.email}*\n🔑 Temporary password: ${m.password}\n🔗 Log in (one-click): ${m.webmailUrl}\n\nTo start receiving mail, add these DNS records to *${parsed.domain}* (I can do this for you if I manage its DNS):\n\n${dnsSteps(m.dns)}\n\nPlease change the password after your first login.`,
      );
    } catch (err) {
      log.error({ err, domain: parsed.domain }, "titan provision failed");
      await this.#reply(msg.channel, msg.chatId, "I hit a snag creating that mailbox — let's try again in a moment.");
    }
  }

  /** "Write me a blog post / captions …" → generate ready-to-publish marketing copy. */
  async #handleContent(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    const currentHtml = c.siteId ? await resolveSiteHtml(c.siteId) : null;
    const context = currentHtml ? siteSummary(currentHtml) : null;
    const content = await generateContent(msg.text, context, undefined);
    await this.#reply(
      msg.channel,
      msg.chatId,
      content || "I couldn't write that just now — please try again in a moment.",
    );
  }

  /** "How's my site doing" → a real weekly growth report. */
  async #handleReport(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    if (!c.userId) return;
    const siteIds = await siteIdsForUser(c.userId);
    const report = siteIds.length ? await buildReport(siteIds) : null;
    if (!report) {
      await this.#reply(msg.channel, msg.chatId, "You don't have a live site yet — build one and I'll start tracking how it's doing here. 📊");
      return;
    }
    await this.#reply(msg.channel, msg.chatId, formatReport(report));
  }

  /** Merchant asks to connect payments — explain how (paste their Flutterwave key). */
  async #handleConnectPayment(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    if (!c.siteId) {
      await this.#reply(msg.channel, msg.chatId, "Let's build your shop first — tell me what you sell, and I'll set it up. Then you can connect payments.");
      return;
    }
    await this.#reply(
      msg.channel,
      msg.chatId,
      "Let's connect your store to your own bank/payment account 💳\n\n1) Go to your Flutterwave dashboard → Settings → API Keys.\n2) Copy your *Secret Key* (it starts with `FLWSECK-`).\n3) Paste it here.\n\nI'll store it securely (encrypted), and every sale goes straight to *your* account — Zurum never holds your money.",
    );
  }

  /** The merchant pasted their Flutterwave secret key — store it (encrypted). */
  async #handlePaymentKey(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    if (!c.siteId) {
      await this.#reply(msg.channel, msg.chatId, "Build your shop first, then paste your payment key to start taking orders.");
      return;
    }
    const currency = (c.userId ? await getUserCurrency(c.userId) : null) ?? "NGN";
    const ok = await setPaymentConfig(c.siteId, msg.text.trim(), currency).catch(() => false);
    await this.#reply(
      msg.channel,
      msg.chatId,
      ok
        ? `✅ Payments connected! Your shop can now take real orders in ${currency}, and the money goes straight to your account. Add products with e.g. *"add product Sneakers 25000"*.`
        : "I couldn't save that key just now — please try pasting it again in a moment.",
    );
  }

  /** "add product X 5000" → create a product on the merchant's shop. */
  async #handleAddProduct(c: conv.Conversation, msg: IncomingMessage, p: { name: string; price: number }): Promise<void> {
    if (!c.siteId) {
      await this.#reply(msg.channel, msg.chatId, "Let's build your shop first, then you can add products to it.");
      return;
    }
    const currency = (c.userId ? await getUserCurrency(c.userId) : null) ?? "NGN";
    await addProduct(c.siteId, p.name, p.price, currency);
    const store = await getStoreInfo(c.siteId);
    const tip = store.live ? "" : "\n\n💡 Connect payments (say *\"connect payment\"*) so buyers can actually check out.";
    await this.#reply(
      msg.channel,
      msg.chatId,
      `✅ Added *${p.name}* — ${currency} ${p.price.toLocaleString()}. It'll show in your shop automatically.${tip}`,
    );
  }

  /** "my sales / my orders" → the merchant's real store takings. */
  async #handleSales(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    if (!c.siteId) {
      await this.#reply(msg.channel, msg.chatId, "You don't have a shop yet — tell me what you'd like to sell and I'll build one.");
      return;
    }
    const [stats, orders, products] = await Promise.all([
      orderStats(c.siteId),
      listOrders(c.siteId, 5),
      listProducts(c.siteId, false),
    ]);
    if (stats.orders === 0) {
      await this.#reply(
        msg.channel,
        msg.chatId,
        products.length
          ? "No orders yet 🛒 — share your shop link and the sales will show up here."
          : "Your shop has no products yet. Add one with e.g. *\"add product Sneakers 25000\"*.",
      );
      return;
    }
    const recent = orders
      .map((o) => `• ${o.currency} ${o.amount.toLocaleString()} — ${o.status === "paid" ? "✅ paid" : "⌛ pending"}${o.buyerName ? ` (${o.buyerName})` : ""}`)
      .join("\n");
    await this.#reply(
      msg.channel,
      msg.chatId,
      `🛒 *Your sales*\n\nRevenue: *${stats.currency} ${stats.revenue.toLocaleString()}* from ${stats.paid} paid order${stats.paid === 1 ? "" : "s"} (${stats.orders} total).\n\nRecent:\n${recent}`,
    );
  }

  /** Show the site owner how many people signed up on their site + the latest few. */
  async #handleSignupsQuestion(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    if (!c.siteId) {
      await this.#reply(
        msg.channel,
        msg.chatId,
        "You don't have a site with sign-ups yet — build one with a login and I'll track its members for you here. 👥",
      );
      return;
    }
    const [stats, recent, plan] = await Promise.all([
      backendStats(c.siteId),
      listSiteUsers(c.siteId, 8),
      planFor(c.siteId),
    ]);
    if (stats.users === 0) {
      await this.#reply(
        msg.channel,
        msg.chatId,
        plan === "dynamic"
          ? "No sign-ups yet 👥 — once your site is published, people can create accounts and they'll show up here."
          : "This site doesn't have a login/sign-up yet. Want me to add one? Just say \"add a login and sign-up\".",
      );
      return;
    }
    const lines = recent.map((u) => `• ${u.name ? `${u.name} — ` : ""}${u.email}`).join("\n");
    const more = stats.users > recent.length ? `\n…and ${stats.users - recent.length} more.` : "";
    const records = stats.records ? ` and ${stats.records} saved record${stats.records === 1 ? "" : "s"}` : "";
    await this.#reply(
      msg.channel,
      msg.chatId,
      `👥 You have *${stats.users}* sign-up${stats.users === 1 ? "" : "s"}${records} on your site.\n\nMost recent:\n${lines}${more}`,
    );
  }

  /** Send the customer a private magic link to their own dashboard/panel. */
  async #sendPanelLink(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    if (!c.userId) {
      await this.#reply(
        msg.channel,
        msg.chatId,
        "I'll set up your dashboard as soon as we've started your first site — just describe what you'd like and it'll show up there.",
      );
      return;
    }
    const token = await createPanelToken(c.userId);
    const link = `${BASE_URL}/me/${token}`;
    await this.#reply(
      msg.channel,
      msg.chatId,
      `Here's your private dashboard — your sites, your account, and (once a site is live) a one-click export of your code + business data 👇\n\n${link}\n\n(For your security this link expires in 1 hour. Just ask for "my dashboard" anytime to get a fresh one.)`,
    );
  }

  async #sendWallet(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    if (!c.userId) return;
    const [credits, stats, u] = await Promise.all([
      getBalance(c.userId),
      usageStats(c.userId),
      usageFor(c.userId),
    ]);
    const unlimited = isAdminIdentity(msg.channel, msg.from);
    const card = walletCard({
      credits,
      editsUsed: stats.editsUsed,
      editLimit: getNum("free_edit_limit"),
      buildsUsed: stats.buildsUsed,
      buildLimit: unlimited ? null : u.limit,
      unlimited,
    });
    await this.#sender.sendActions(msg.channel, msg.chatId, card, topupActions());
  }

  /** Send the top-up offer with tappable package buttons. */
  async #sendTopupOffer(msg: IncomingMessage): Promise<void> {
    await this.#sender.sendActions(
      msg.channel,
      msg.chatId,
      await phrase(topupOfferMeaning(), msg.text),
      topupActions(),
    );
  }

  /** A top-up package was tapped → resolve currency, then create the payment. */
  async #handleTopupTap(c: conv.Conversation, msg: IncomingMessage, usd: number): Promise<void> {
    if (!isFlutterwaveConfigured() || !c.userId) {
      const credits = creditsForUsd(usd);
      await this.#reply(
        msg.channel,
        msg.chatId,
        `Great choice — $${usd} for ${credits} credits 💳 Paying by card, bank transfer, or USDT is launching very soon. I've noted your request and I'll message you the moment it's ready to pay.`,
      );
      return;
    }
    // Currency: stored preference → inferred from phone (WhatsApp) → ask once.
    let currency = await getUserCurrency(c.userId);
    if (!currency) {
      const inferred = currencyFromChannel(msg.channel, msg.from);
      if (inferred) {
        await setUserCurrency(c.userId, inferred);
        currency = inferred;
      }
    }
    if (!currency) {
      // Ask once — the buttons carry the amount, so no extra state is needed.
      await this.#sender.sendActions(msg.channel, msg.chatId, "Which currency would you like to pay in?", [
        { id: `cur_NGN_${usd}`, label: "🇳🇬 Naira (₦)" },
        { id: `cur_USD_${usd}`, label: "🌍 US Dollars ($)" },
      ]);
      return;
    }
    await this.#createTopupPayment(c, msg, usd, currency);
  }

  /** Create the Flutterwave checkout for a known amount + currency. */
  async #createTopupPayment(
    c: conv.Conversation,
    msg: IncomingMessage,
    usd: number,
    currency: string,
  ): Promise<void> {
    if (!c.userId) return;
    const credits = creditsForUsd(usd);
    const amount = await amountFor(usd, currency);
    const txRef = `zurum-${randomUUID().slice(0, 8)}`;

    // Fraud/abuse gate (§14.4). Blocks only an extreme card-testing velocity; a
    // normal retry scores well below the threshold and passes straight through.
    const risk = await scoreTopup({ userId: c.userId, amount, currency });
    if (risk.action !== "allow") await recordFraudFlag(c.userId, txRef, risk);
    if (risk.action === "block") {
      await this.#say(
        msg,
        "For your security we've paused new payments on this account for a few minutes. Please try again shortly, or reply and a human will help.",
      );
      return;
    }

    try {
      const { link } = await createPayment({
        txRef,
        amount,
        currency,
        email: `${msg.channel}.${msg.from}@zurum.pay`,
        name: "Zurum Customer",
        credits,
      });
      await createTopup({ userId: c.userId, txRef, credits, amount, currency });
      const text =
        `Here's your secure payment for ${credits} credits (${formatAmount(amount, currency)}) 💳\n` +
        `Pay by card, bank transfer or USSD here:\n${link}\n\n` +
        `Once you've paid, tap "✅ I've paid" and I'll add your credits right away.`;
      await this.#sender.sendActions(msg.channel, msg.chatId, text, [
        { id: `paid_${txRef}`, label: "✅ I've paid" },
      ]);
    } catch (err) {
      log.error({ err, txRef }, "create payment failed");
      await this.#say(msg, "Sorry — I couldn't set up the payment just now. Please try again in a moment.");
    }
  }

  /** "I've paid" tapped → verify with Flutterwave and credit the wallet (idempotent). */
  async #handlePaidTap(c: conv.Conversation, msg: IncomingMessage, txRef: string): Promise<void> {
    const topup = await getTopup(txRef);
    if (!topup) {
      await this.#reply(msg.channel, msg.chatId, "Hmm, I can't find that payment. Tap a top-up package to start again.");
      return;
    }
    const verified = await verifyByReference(txRef);
    const paid =
      verified?.status === "successful" &&
      verified.currency === topup.currency &&
      verified.amount >= topup.amount;
    if (!paid) {
      await this.#reply(
        msg.channel,
        msg.chatId,
        "I don't see your payment yet — if you just paid, give it a few seconds and tap “✅ I've paid” again.",
      );
      return;
    }
    const userId = topup.userId ?? c.userId;
    const credited = await markPaid(txRef); // credits if THIS call flipped it, else null (already paid)
    if (credited !== null && userId) {
      const balance = await grant(userId, credited, `top-up ${txRef}`, { resetRef: true });
      await this.#reply(
        msg.channel,
        msg.chatId,
        `🎉 Payment confirmed! ${credited} credits added. Your balance is now ${balance}. Let's keep building!`,
      );
    } else {
      const balance = userId ? await getBalance(userId) : 0;
      await this.#reply(msg.channel, msg.chatId, `You're already credited for this payment ✅ Your balance is ${balance}.`);
    }
  }

  // ── Publishing (the paid annual host+domain fee) ────────

  /**
   * The customer wants to take their site LIVE. Building + preview are free; this
   * is the one-time annual fee (host + domain), tier-priced. Admins publish free;
   * an already-published site (e.g. approving an edit) re-deploys free.
   */
  async #handlePublish(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    if (!c.jobId && !c.siteId) {
      await this.#say(msg, "Let's build your site first — tell me what you'd like and I'll create it. 🛠️");
      return;
    }
    const admin = isAdminIdentity(msg.channel, msg.from);
    const already = c.siteId ? await isPublished(c.siteId) : false;
    if (admin || already) {
      // Admins publish free (still mark it published so the preview banner is
      // removed and it serves clean).
      if (admin && !already && c.siteId) {
        await markPublished(c.siteId, await planFor(c.siteId), 0, `admin:${msg.channel}:${msg.from}`);
      }
      if (c.jobId) await this.#maestro.approve(c.jobId);
      await this.#say(
        msg,
        already
          ? "Publishing your latest changes live now! 🚀"
          : "Great — I'm publishing your site live now! 🚀",
      );
      return;
    }
    await this.#beginPublishPayment(c, msg);
  }

  /** Resolve currency (stored → phone → ask), then create the publish payment. */
  async #beginPublishPayment(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    if (!isFlutterwaveConfigured() || !c.userId || !c.siteId) {
      await this.#say(
        msg,
        "Your site is ready to go live! 🎉 Paying to publish (card, bank transfer or USSD) is launching very soon — I've noted it and I'll message you the moment it's ready.",
      );
      return;
    }
    let currency = await getUserCurrency(c.userId);
    if (!currency) {
      const inferred = currencyFromChannel(msg.channel, msg.from);
      if (inferred) {
        await setUserCurrency(c.userId, inferred);
        currency = inferred;
      }
    }
    if (!currency) {
      await this.#sender.sendActions(
        msg.channel,
        msg.chatId,
        "Your site is ready to go live! 🎉 To publish it for a year — hosting AND your own domain included — which currency would you like to pay in?",
        [
          { id: "pubcur_NGN", label: "🇳🇬 Naira (₦)" },
          { id: "pubcur_USD", label: "🌍 US Dollars ($)" },
        ],
      );
      return;
    }
    await this.#createPublishPayment(c, msg, currency);
  }

  /** Create the Flutterwave checkout for the tier's annual publish fee. */
  async #createPublishPayment(
    c: conv.Conversation,
    msg: IncomingMessage,
    currency: string,
  ): Promise<void> {
    if (!c.userId || !c.siteId) return;
    const plan = await planFor(c.siteId);
    const price = publishPriceUsd(plan);
    const amount = await amountFor(price, currency);
    const txRef = `zpub-${randomUUID().slice(0, 8)}`;
    try {
      const { link } = await createPayment({
        txRef,
        amount,
        currency,
        email: `${msg.channel}.${msg.from}@zurum.pay`,
        name: "Zurum Customer",
        credits: 0,
      });
      await createPublishOrder({ txRef, userId: c.userId, siteId: c.siteId, plan, priceUsd: price, amount, currency });
      const kind = plan === "dynamic" ? "dashboard" : "website";
      const text =
        `To publish your ${kind} live for 1 year — hosting + your own domain included — it's ` +
        `${formatAmount(amount, currency)} 💳\nPay by card, bank transfer or USSD here:\n${link}\n\n` +
        `Once you've paid, tap "✅ I've paid" and I'll take it live right away.`;
      await this.#sender.sendActions(msg.channel, msg.chatId, text, [
        { id: `pubpaid_${txRef}`, label: "✅ I've paid" },
      ]);
    } catch (err) {
      log.error({ err, txRef }, "create publish payment failed");
      await this.#say(msg, "Sorry — I couldn't set up the payment just now. Please try again in a moment.");
    }
  }

  /** "I've paid" for a publish → verify, mark the site live, finalize, offer domain. */
  async #handlePublishPaidTap(c: conv.Conversation, msg: IncomingMessage, txRef: string): Promise<void> {
    const order = await getPublishOrder(txRef);
    if (!order) {
      await this.#reply(msg.channel, msg.chatId, "Hmm, I can't find that payment. Tap “✅ Publish it live” to start again.");
      return;
    }
    const verified = await verifyByReference(txRef);
    const paid =
      verified?.status === "successful" &&
      verified.currency === order.currency &&
      verified.amount >= order.amount;
    if (!paid) {
      await this.#reply(
        msg.channel,
        msg.chatId,
        "I don't see your payment yet — if you just paid, give it a few seconds and tap “✅ I've paid” again.",
      );
      return;
    }
    // Flip the order once (idempotent); only THAT call publishes + finalizes.
    const flipped = await markPublishOrderPaid(txRef);
    if (flipped) {
      await markPublished(order.siteId, order.plan, order.priceUsd, txRef);
      if (c.jobId) await this.#maestro.approve(c.jobId);
      await this.#reply(
        msg.channel,
        msg.chatId,
        "🎉 Payment confirmed — your site is now PUBLISHED and live for 1 year! 🚀",
      );
      await this.#say(
        msg,
        "Would you like to connect your own custom domain (like yourname.com)? Just tell me the domain and I'll set it up — it's included. 🌐",
      );
    } else {
      await this.#reply(msg.channel, msg.chatId, "You're already published for this payment ✅ Your site is live.");
    }
  }

  /**
   * Gate a NEW build: free sites first, then credits, else block with a top-up
   * prompt (with tappable package buttons). Returns the charge `mode` so the
   * caller can apply it and record it on the job (for refund-on-failure).
   */
  async #buildGate(
    c: conv.Conversation,
    msg: IncomingMessage,
  ): Promise<{ ok: boolean; mode: Charge }> {
    if (!c.userId) return { ok: true, mode: "exempt" }; // fail open — never block on a missing id
    const m = await checkBuildMeter(c.userId, msg.channel, msg.from);
    if (!m.allowed) {
      log.info({ userId: c.userId, balance: m.balance }, "build blocked — no free sites, no credits");
      await this.#sender.sendActions(
        msg.channel,
        msg.chatId,
        await phrase(buildBlockedMeaning(m.cost, m.balance, getNum("min_topup_usd")), msg.text),
        topupActions(),
      );
      return { ok: false, mode: "exempt" };
    }
    return { ok: true, mode: m.mode! };
  }

  /**
   * Gate an EDIT: free edits first, then credits, else block with a top-up
   * prompt. Returns the charge `mode` for the caller to apply + record.
   */
  async #editGate(
    c: conv.Conversation,
    msg: IncomingMessage,
  ): Promise<{ ok: boolean; mode: Charge }> {
    if (!c.userId) return { ok: true, mode: "exempt" };
    const m = await checkEditMeter(c.userId, msg.channel, msg.from);
    if (!m.allowed) {
      log.info({ userId: c.userId, balance: m.balance }, "edit blocked — no free edits, no credits");
      await this.#sender.sendActions(
        msg.channel,
        msg.chatId,
        await phrase(editBlockedMeaning(m.balance, m.cost, getNum("min_topup_usd")), msg.text),
        topupActions(),
      );
      return { ok: false, mode: "exempt" };
    }
    return { ok: true, mode: m.mode! };
  }

  #buildNotifier() {
    const target = (job: Job) => ({
      channel: job.input["channel"] as ChannelName | undefined,
      chatId: job.input["chatId"] as string | undefined,
    });
    return {
      onAwaitingApproval: async (job: Job) => {
        const c = await conv.byJob(job.id);
        if (c) {
          // Point the conversation at this site ONLY now that it actually exists
          // (built + promoted). A failed build never gets here, so it can never
          // overwrite the customer's current good site — fixes the "we haven't
          // built one together" / "edit: current site not found" memory bug.
          const siteId = job.input["siteId"] as string | undefined;
          if (siteId) await conv.setSite(c.id, siteId);
          await conv.setPhase(c.id, "awaiting_approval");
        }
        const { channel, chatId } = target(job);
        if (!channel || !chatId) return;
        const preview = job.checkpoint.data["previewUrl"] ?? "(preview)";
        const live = job.checkpoint.data["live"] === true;
        const text = await phrase(
          live
            ? "Your website is ready 👇 Open it on any device — phone or computer — and share it with anyone. Happy with it, or want any changes?"
            : "Your website preview is ready to look at 👇",
          lastUserText(c),
        );
        await this.#sender.sendActions(channel, chatId, `${text}\n${preview}`, APPROVAL_ACTIONS);
      },
      onCompleted: async (job: Job) => {
        const c = await conv.byJob(job.id);
        if (c) await conv.setPhase(c.id, "done");
        const { channel, chatId } = target(job);
        if (!channel || !chatId) return;
        const url = job.checkpoint.data["deployedUrl"] ?? "(preview)";
        const live = job.checkpoint.data["live"] === true;
        // Honest labelling: only call it LIVE when it's really deployed to public
        // hosting. Without hosting configured it's still a local preview link.
        const text = await phrase(
          live
            ? "🎉 Your website is LIVE on the internet! Anyone, anywhere can open this link — share it on WhatsApp, Instagram, your business card, anywhere. Want your own custom domain (like yourname.com)? Just tell me. And message me any time to make changes."
            : "🎉 Your site is approved and ready! Here's your preview link — publishing it to your own domain is the next step. Message me any time to make changes.",
          lastUserText(c),
        );
        await this.#reply(channel, chatId, `${text}\n${url}`);
      },
      onFailed: async (job: Job) => {
        const c = await conv.byJob(job.id);
        const { channel, chatId } = target(job);
        // Reset state so the conversation is never stuck in "building". A failed
        // edit leaves the previous good site intact (it was never promoted).
        if (c) {
          await conv.setPhase(c.id, c.siteId ? "awaiting_approval" : "intake");
          // A failed action shouldn't cost the customer — reverse exactly what
          // was charged (a free slot or credits), based on the recorded mode.
          const mode = job.input["chargeMode"] as Charge | undefined;
          if (c.userId && mode && mode !== "exempt") {
            try {
              if (job.type === "edit") await reverseEditCharge(c.userId, mode);
              else await reverseBuildCharge(c.userId, mode);
            } catch (err) {
              log.warn({ err }, "charge reversal failed (non-fatal)");
            }
          }
        }
        if (!channel || !chatId) return;
        const text = await phrase(
          "Sorry — that didn't go through and your change was NOT applied. Please send the same request again and I'll retry it.",
          lastUserText(c),
        );
        await this.#reply(channel, chatId, text);
      },
    };
  }

  /**
   * Build from a reference website. `exact` = the customer confirmed they own
   * it, so we recreate the design closely; otherwise it's style inspiration
   * only (original copy, no borrowed branding) — see the AUP.
   */
  async #buildFromReference(
    c: conv.Conversation,
    msg: IncomingMessage,
    url: string,
    exact: boolean,
  ): Promise<void> {
    await conv.setPendingUrl(c.id, null);
    const gate = await this.#buildGate(c, msg);
    if (!gate.ok) return; // over quota — the gate already replied
    await this.#say(
      msg,
      exact
        ? "Great — I'm looking at your site now and rebuilding it. Give me a minute or two. 🛠️"
        : "Perfect — I'll use it as inspiration and build you an original site in that style. One or two minutes. 🛠️",
    );

    const siteId = randomUUID();
    const input: Record<string, unknown> = {
      channel: msg.channel,
      chatId: msg.chatId,
      siteId,
      chargeMode: gate.mode,
    };

    if (exact) {
      // High-fidelity clone: render + copy the real page in the worker. A plain
      // pre-fetch here would wrongly reject JS-heavy sites a browser can render,
      // so we let the pipeline do it (with a blueprint fallback baked in).
      input["cloneUrl"] = url;
      input["description"] = `Recreate the website at ${url}`;
    } else {
      // Inspiration only: distil a style brief now (this also confirms the link
      // is reachable before we commit to a build).
      try {
        const bp = await fetchBlueprint(url);
        input["description"] = blueprintToBrief(bp, false);
      } catch (err) {
        log.warn({ url, err }, "blueprint fetch failed");
        await this.#say(
          msg,
          "I couldn't open that link — it may be private or blocking me. Could you describe the site instead and I'll build it?",
        );
        return;
      }
    }

    const jobId = await this.#maestro.submit(input);
    await conv.setPhase(c.id, "building", jobId);
    await this.#charge(c, msg, "build", gate.mode);
    log.info({ jobId, siteId, url, exact }, "reference build submitted");
  }

  /** Recreate a site from an uploaded screenshot/design image (vision → build). */
  async #buildFromImage(
    c: conv.Conversation,
    msg: IncomingMessage,
  ): Promise<void> {
    if (!msg.image) return;
    const gate = await this.#buildGate(c, msg);
    if (!gate.ok) return; // over quota — the gate already replied
    await this.#say(msg, "Looking at your image and building a site from it — one or two minutes. 🛠️");
    const { mime, base64 } = splitDataUri(msg.image.dataUri);
    let brief: string;
    try {
      brief = await describeImageForBuild(base64, mime);
    } catch (err) {
      log.warn({ err }, "vision describe failed");
      await this.#say(msg, "I couldn't read that image clearly — could you describe what you'd like instead?");
      return;
    }
    const siteId = randomUUID();
    const jobId = await this.#maestro.submit({
      description: `Recreate this design as closely as possible.\n\n${brief}`,
      channel: msg.channel,
      chatId: msg.chatId,
      siteId,
      chargeMode: gate.mode,
    });
    await conv.setPhase(c.id, "building", jobId);
    await this.#charge(c, msg, "build", gate.mode);
    log.info({ jobId, siteId }, "image-reference build submitted");
  }

  /**
   * The customer sent a screenshot of THEIR site pointing at something to change
   * (e.g. a circled area). Use vision to turn it into a precise edit — never
   * treat it as a logo. If we can't see images, ask them to describe it in words.
   */
  async #editFromImage(c: conv.Conversation, msg: IncomingMessage): Promise<void> {
    if (!msg.image || !c.siteId) return;
    if (!canSeeImages()) {
      await this.#say(
        msg,
        'I can see you attached an image 📸 — but I can\'t read images clearly just yet, so I won\'t guess. Tell me the change in words (e.g. "make the logo smaller", "remove the top banner", "change the circled button to green") and I\'ll fix it right away.',
      );
      return;
    }
    await this.#say(msg, "Looking at your image to see exactly what to change… 👀");
    const { mime, base64 } = splitDataUri(msg.image.dataUri);
    let editInstruction: string;
    try {
      editInstruction = await describeImageForEdit(base64, mime, msg.text ?? "fix the marked area");
    } catch (err) {
      log.warn({ err }, "vision edit-describe failed");
      await this.#say(msg, "I couldn't read that image clearly — could you tell me the change in words instead?");
      return;
    }
    const gate = await this.#editGate(c, msg);
    if (!gate.ok) return;
    const jobId = await this.#maestro.submitEdit({
      description: editInstruction,
      channel: msg.channel,
      chatId: msg.chatId,
      siteId: c.siteId,
      chargeMode: gate.mode,
    });
    await conv.setPhase(c.id, "building", jobId);
    await this.#charge(c, msg, "edit", gate.mode);
    await this.#say(msg, "Got it — making that change now. 🛠️");
    log.info({ jobId, siteId: c.siteId }, "image-reference edit submitted");
  }

  /** Reply phrased naturally in the customer's language. */
  async #say(msg: IncomingMessage, message: string): Promise<void> {
    await this.#reply(msg.channel, msg.chatId, await phrase(message, msg.text));
  }

  #reply(channel: ChannelName, chatId: string, text: string): Promise<void> {
    // Never send (or let callers store) an empty message — channels reject it
    // and an empty assistant turn corrupts the conversation history.
    const safe = text && text.trim() ? text : "…";
    return this.#sender.send(channel, chatId, safe);
  }
}
