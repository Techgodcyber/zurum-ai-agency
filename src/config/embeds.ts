import { env } from "./env.js";

/**
 * Third-party widget providers a customer may legitimately embed on their own
 * site (live chat, helpdesk, chatbots). Scripts from these hosts are permitted
 * by Guardian; anything else external is still blocked, so this list is the
 * trust boundary — keep it to well-known vendors.
 *
 * Extend at runtime with EXTRA_EMBED_HOSTS (comma-separated) — no code change or
 * redeploy needed when a customer turns up with a provider we haven't listed.
 */
const BUILTIN_EMBED_HOSTS = [
  // Live chat / messaging
  "tidio.co",
  "tidiochat.com",
  "smartsuppchat.com",
  "smartsupp.com",
  "tawk.to",
  "crisp.chat",
  "intercom.io",
  "intercomcdn.com",
  "livechatinc.com",
  "livechat.com",
  "jivosite.com",
  "jivochat.com",
  "chatra.io",
  "chatra.com",
  "chaport.com",
  "olark.com",
  "purechat.com",
  "userlike.com",
  "userlike-cdn.com",
  "chatwoot.com",
  "rocket.chat",
  "chatlio.com",
  // Helpdesk / support suites with chat widgets
  "zdassets.com", // Zendesk
  "zendesk.com",
  "freshchat.com",
  "freshworks.com",
  "freshrelevance.com",
  "helpscout.net",
  "gorgias.chat",
  "gorgias.com",
  "ladesk.com", // LiveAgent
  "liveagent.com",
  "frontapp.com",
  "zoho.com", // SalesIQ
  "zohostatic.com",
  "zohopublic.com",
  // CRM / marketing suites whose widget is commonly requested
  "hs-scripts.com", // HubSpot
  "hubspot.com",
  "hsforms.net",
  "drift.com",
  "driftt.com",
  "brevo.com",
  "sendinblue.com",
  "kommo.com",
  "amocrm.com",
  // Chatbots / omnichannel inboxes
  "manychat.com",
  "landbot.io",
  "chatbot.com",
  "trengo.com",
  "respond.io",
  "tars.com",
  // Social messaging plugins
  "connect.facebook.net", // Messenger chat plugin
];

/** Built-ins plus any operator-configured extras. */
export const TRUSTED_EMBED_HOSTS: string[] = [
  ...BUILTIN_EMBED_HOSTS,
  ...(env.EXTRA_EMBED_HOSTS?.split(",")
    .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, ""))
    .filter(Boolean) ?? []),
];

/** True when a URL's host is an approved embed provider. */
export function isTrustedEmbedHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return TRUSTED_EMBED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Image CDNs whose photos we deliberately allow in generated sites — real
 * photography is the biggest driver of a site looking rich vs. "AI slop". Only
 * IMAGES from these hosts are permitted (Guardian still blocks scripts/frames
 * from them); safe now that sites deploy to real hosting, not offline sandboxes.
 */
const TRUSTED_IMAGE_HOSTS = [
  "images.pexels.com",
  "pexels.com",
  "images.unsplash.com",
  "unsplash.com",
  "cdn.pixabay.com",
  "pixabay.com",
];

/** True when a URL's host is an approved stock-photo CDN. */
export function isTrustedImageHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return TRUSTED_IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Where a customer finds their widget ID, per provider. Shown when they ask for
 * a chat widget but haven't given us the ID — otherwise they'd silently get the
 * WhatsApp fallback and wonder why their provider wasn't used.
 */
const PROVIDER_GUIDES: { match: RegExp; name: string; steps: string }[] = [
  { match: /\btidio\b/i, name: "Tidio", steps: "Log in to Tidio → Settings → Developer (or Installation) → copy your public key / the code.tidio.co snippet." },
  { match: /\btawk\.?\s?to\b|\btawk\b/i, name: "Tawk.to", steps: "Log in to Tawk.to → Administration → Chat Widget → copy the Widget Code (it looks like embed.tawk.to/xxxxx/default)." },
  { match: /\bcrisp\b/i, name: "Crisp", steps: "Log in to Crisp → Settings → Website Settings → Setup instructions → copy your Website ID." },
  { match: /\bsmart\s?supp\b/i, name: "SmartSupp", steps: "Log in to SmartSupp → Settings → Chat box → Installation → copy your key." },
  { match: /\bintercom\b/i, name: "Intercom", steps: "Log in to Intercom → Settings → Installation → copy your App ID." },
  { match: /\bzendesk\b/i, name: "Zendesk", steps: "Zendesk Admin Center → Channels → Messaging/Widget → copy the widget snippet key." },
  { match: /\bfresh\s?chat\b|\bfreshworks\b/i, name: "Freshchat", steps: "Freshchat → Admin → Web Messenger → copy your widget token." },
  { match: /\bhubspot\b/i, name: "HubSpot", steps: "HubSpot → Settings → Tracking Code → copy your Hub ID." },
  // NOTE: one word only — "live chat" (two words) is the generic phrase, not the
  // LiveChat.com product, and must not be mistaken for it.
  { match: /\blivechat(inc)?\b/i, name: "LiveChat", steps: "LiveChat → Settings → Chat widget → Installation → copy your license number." },
  { match: /\bjivo\s?(chat|site)?\b/i, name: "JivoChat", steps: "JivoChat → Manage → Channels → copy your widget code." },
  { match: /\bchatra\b/i, name: "Chatra", steps: "Chatra → Settings → Setup & Install → copy your Chatra ID." },
  { match: /\bdrift\b/i, name: "Drift", steps: "Drift → Settings → App Settings → Chat Widget → copy your Drift ID." },
  { match: /\bmany\s?chat\b/i, name: "ManyChat", steps: "ManyChat → Growth Tools → Website widget → copy the embed code." },
  { match: /\bland\s?bot\b/i, name: "Landbot", steps: "Landbot → your bot → Share → Embed → copy the embed code." },
  { match: /\bgorgias\b/i, name: "Gorgias", steps: "Gorgias → Settings → Chat → Installation → copy your snippet." },
  { match: /\bolark\b/i, name: "Olark", steps: "Olark → Settings → Install → copy your Site ID." },
  { match: /\bhelp\s?scout\b/i, name: "Help Scout", steps: "Help Scout → Beacons → your Beacon → Installation → copy your Beacon ID." },
  { match: /\bzoho\b/i, name: "Zoho SalesIQ", steps: "Zoho SalesIQ → Settings → Brands → Installation → copy your widget code." },
];

/** True if the message already appears to contain a widget id / pasted snippet. */
function looksLikeWidgetId(text: string): boolean {
  if (/\b(id|key|code|token|licen[cs]e)\b\s*[:=-]?\s*\S{4,}/i.test(text)) return true;
  if (/<script[\s\S]*src=/i.test(text)) return true; // pasted full snippet
  // A standalone token that looks like an id (long, mixed alphanumeric).
  return /\b(?=[A-Za-z0-9_-]{8,})(?=[^\s]*\d)[A-Za-z0-9_-]{8,}\b/.test(text);
}

/**
 * Detects "add <provider> live chat" without an id, so we can ask for it and
 * explain exactly where to find it instead of silently falling back.
 */
export function chatWidgetRequest(
  text: string,
): { name: string; steps: string } | null {
  if (!/\b(chat|widget|support|helpdesk|messenger)\b/i.test(text)) return null;
  const hit = PROVIDER_GUIDES.find((g) => g.match.test(text));
  if (!hit) return null;
  if (looksLikeWidgetId(text)) return null; // they already gave it
  return { name: hit.name, steps: hit.steps };
}

/** Provider names shown to Forge so it only embeds ones Guardian will accept. */
export const SUPPORTED_CHAT_PROVIDERS =
  "Tidio, SmartSupp, Tawk.to, Crisp, Intercom, Zendesk, LiveChat, JivoChat, " +
  "Chatra, Chaport, Olark, Pure Chat, Userlike, Chatwoot, Rocket.Chat, " +
  "Freshchat, Help Scout, Gorgias, LiveAgent, Front, Zoho SalesIQ, HubSpot, " +
  "Drift, Brevo, Kommo, ManyChat, Landbot, Trengo, Respond.io, Facebook Messenger";
