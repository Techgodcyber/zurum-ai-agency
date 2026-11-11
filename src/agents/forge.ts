import { callModel } from "../models/index.js";
import { SUPPORTED_CHAT_PROVIDERS } from "../config/embeds.js";
import { logger } from "../lib/logger.js";
import type { StockPhoto } from "../media/images.js";

const log = logger.child({ mod: "forge" });

/**
 * Forge — the builder. Turns a build spec into a real, self-contained website.
 *
 * v1 generates a single-file, dependency-free HTML document (embedded CSS, no
 * external fetches) so it can be served instantly and is safe to sandbox/host.
 * The template library and Frontend/Backend split come in later slices; for now
 * this already produces a genuine, viewable site — the "type a sentence, get a
 * real webpage" moment.
 *
 * Routing: forge-design → full Kimi k2.7-code (quality over the highspeed variant)
 * → Anthropic/others as fallback. Real photos (Pexels) are passed in via the
 * palette so sites look premium instead of flat.
 */
const SYSTEM = `You are Forge, an elite web designer and front-end engineer. Design
a STUNNING, modern, production-quality website as a SINGLE self-contained HTML5
file for the brief below — the calibre a top design agency would ship.

DESIGN BAR (make it genuinely impressive — never generic):
- A striking HERO: bold headline with a clear value proposition, a supporting line,
  and a prominent call-to-action button, over a real photo or a rich gradient.
- A RICH, full layout — multiple well-crafted sections with real, specific copy
  tailored to THIS business (never lorem ipsum): hero, about/story, services or
  features as cards, gallery/showcase, testimonials or social proof, key stats,
  pricing or menu if relevant, FAQ, a strong contact/CTA, and a proper footer.
- Modern visual craft: a cohesive, tasteful color palette; a confident typographic
  scale (large, striking headings); generous whitespace and consistent spacing;
  rounded corners, layered depth with soft shadows, and subtle hover / on-scroll
  micro-interactions that feel polished.
- NAVIGATION — DEFAULT to a clean, sticky TOP navbar with the links shown inline on
  desktop. Use a left SIDEBAR layout ONLY when the customer explicitly asks for one
  (or asks for a "dashboard/admin" layout) — NEVER by default, and never just because
  the site has a login. On desktop always show the full nav links inline in a real top
  bar; collapse to a hamburger ONLY on mobile (never a hamburger/dropdown on desktop).
  NEVER render a mobile-style off-canvas/overlay sidebar on a desktop screen. If a
  sidebar IS requested, it must be a proper fixed, full-height sidebar on large screens
  and collapse to a drawer on mobile. Make different sites feel visually distinct.
- Fully mobile-first responsive and accessible (semantic HTML, strong contrast,
  alt text on every image).

TECHNICAL RULES:
- ONE self-contained file. Embed all CSS in a <style> tag; tasteful vanilla JS
  inline in a <script> tag only where it adds polish (mobile menu, smooth scroll,
  simple reveal-on-scroll).
- IMAGES: when REAL PHOTO URLs are provided, USE MANY of them — real photography is
  the #1 thing that makes a site look professional. Weave them throughout: a large
  hero image or background, a gallery/showcase grid, photos inside service/feature
  cards, section backgrounds, and team/testimonial images. Aim to use most of the
  provided photos (6+), never leave a section flat when a fitting photo exists.
  Reference them directly (<img src="…"> or CSS background-image) with descriptive
  alt text and proper object-fit cover. If NO photos are provided, use rich CSS
  gradients and inline SVG. Never invent image URLs beyond the ones provided.
- NO other external resources: no CDN scripts, no external fonts or stylesheets, no
  analytics, no third-party iframes (except an explicitly provided live-chat widget).
  Use system font stacks. Only the provided image hosts and provided widget.
- FORMS: when a form endpoint is given in the brief, EVERY form (contact, booking,
  enquiry, newsletter) must be a real working form: <form method="POST"
  action="THAT_EXACT_URL"> with named inputs (name, email, phone, message, …), a
  hidden <input type="hidden" name="_form" value="contact"> naming the form, and a
  hidden honeypot <input type="text" name="_hp" style="display:none" tabindex="-1"
  autocomplete="off">. Do not add JS that blocks submission. If no endpoint is
  given, use a mailto: form instead.
- Outbound LINKS are encouraged where implied: WhatsApp click-to-chat
  (https://wa.me/<number-in-international-format>), social profiles, Google Maps,
  tel: and mailto:. If a phone number is given, add a floating "Chat with us"
  WhatsApp button.
- LIVE CHAT: if the brief includes a widget ID for a supported provider, embed that
  provider's official snippet with the given ID. Supported: ${SUPPORTED_CHAT_PROVIDERS}.
  If live chat is requested without an ID, use the WhatsApp button instead — never
  invent a fake widget ID, and never embed a provider outside that list.

Output a COMPLETE document and ALWAYS finish with the closing </body></html> tags —
never stop mid-tag. Output ONLY the raw HTML, starting exactly with <!DOCTYPE html>:
no markdown code fences, no explanation before or after.`;

export interface ForgeResult {
  html: string;
  costUsd: number;
  tokens: number;
}

/** Strip accidental markdown fences / preamble and normalise to a clean doc. */
function cleanHtml(raw: string): string {
  let s = raw.trim();
  // Remove ```html … ``` fences if the model added them.
  s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  // Drop anything before the doctype/html start.
  const start = s.search(/<!DOCTYPE html|<html/i);
  if (start > 0) s = s.slice(start);
  return s.trim();
}

/** A complete document ends with the closing html tag. */
export function isComplete(html: string): boolean {
  return /<\/html>\s*$/i.test(html.trim());
}

/**
 * Generate HTML for the given system+user prompt, and if the output comes back
 * truncated (didn't finish the document — common on big multi-section sites),
 * retry ONCE with more room and a "be complete and compact" nudge. Prevents the
 * "unclosed <html>" failures on large builds/edits.
 */
/**
 * Token Forge is told to use as the logo's img src. We swap it for the real
 * base64 data URI AFTER generation, so the (large) image never costs tokens and
 * the final file stays self-contained.
 */
const LOGO_TOKEN = "LOGO_SRC_PLACEHOLDER";

async function generateDoc(
  system: string,
  userContent: string,
  jobId: string,
  signal?: AbortSignal,
  logoDataUri?: string | null,
): Promise<ForgeResult> {
  // An existing site already embeds the logo as a huge base64 string. Never send
  // that to the model (cost + context blowout): swap any data URI for the token
  // and restore it afterwards.
  let embedded: string | null = null;
  const safeContent = userContent.replace(
    /data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/g,
    (match) => {
      embedded ??= match;
      return LOGO_TOKEN;
    },
  );
  const logo = logoDataUri ?? embedded;

  const logoRule = logo
    ? `\n\nLOGO: The customer has provided their own logo image. Show it as the site's ` +
      `logo in the header (and hero if fitting) with EXACTLY this src: ` +
      `<img src="${LOGO_TOKEN}" alt="logo"> — do not invent a different logo, and do ` +
      `not alter that src string.`
    : "";
  const call = (maxTokens: number, extra = "") =>
    callModel("forge-design", {
      system: system + logoRule + extra,
      messages: [{ role: "user", content: safeContent }],
      maxTokens,
      thinking: false,
      effort: "high",
      jobId,
      signal,
    });

  // Generous first-pass budget so a rich, image-heavy site completes in ONE call
  // (a truncation retry regenerates the whole doc — slow, and it's what pushed big
  // Sonnet builds past the time cap).
  let res = await call(32_000);
  let html = cleanHtml(res.text);
  let costUsd = res.costUsd;
  let tokens = res.usage.inputTokens + res.usage.outputTokens;

  if (!isComplete(html)) {
    log.warn({ bytes: html.length }, "output truncated — retrying with more room");
    const res2 = await call(
      48_000,
      "\n\nIMPORTANT: Your previous attempt was CUT OFF before the end. Produce the " +
        "COMPLETE document this time and keep it COMPACT enough to finish — it MUST end " +
        "with </body></html>. Prefer fewer, tighter sections over an oversized file.",
    );
    const html2 = cleanHtml(res2.text);
    costUsd += res2.costUsd;
    tokens += res2.usage.inputTokens + res2.usage.outputTokens;
    // Keep the better result (complete wins; otherwise the longer one).
    if (isComplete(html2) || html2.length > html.length) html = html2;
  }

  // Swap the placeholder back for the real image (kept out of the model context).
  if (logo) html = html.split(LOGO_TOKEN).join(logo);

  log.info(
    { model: `${res.spec.provider}:${res.spec.model}`, bytes: html.length, complete: isComplete(html), costUsd },
    "doc generated",
  );
  return { html, costUsd, tokens };
}

/**
 * Backend building-block (§14): when a site needs real accounts/dashboards, Forge
 * wires the UI to the Zurum runtime via data-attributes — it never writes its own
 * auth or fetch code (the runtime is injected after generation). This is the
 * "constrained generation" rail: the AI fills in the UI, not the security code.
 */
const BACKEND_BLOCK = `

BACKEND — REAL ACCOUNTS & DATA (this site has a Zurum backend, so logins actually work):
- PAGE STRUCTURE (important): the LOGIN and REGISTER forms must each live on their OWN
  separate SCREEN, hidden by default, shown ONLY when the visitor clicks "Log in" or
  "Sign up". They must NEVER appear inline in the homepage's scrollable content — the
  homepage is the normal marketing/landing page, with "Log in" / "Sign up" buttons in
  the nav. The DASHBOARD is likewise its own screen, shown after login. Build these as
  full-screen sections in the single file (e.g. <section id="home">, <section id="login"
  hidden>, <section id="register" hidden>, <section id="dashboard" hidden>) and add a
  tiny script so only ONE screen is visible at a time and the nav / links switch between
  them (a link to "#login" shows the login screen and hides the others). Do NOT stack
  login, register or dashboard into the homepage scroll.
- The Zurum runtime (a global \`window.Zurum\`) is injected AUTOMATICALLY after you
  build. DO NOT write your own login/signup JavaScript, fetch() calls, localStorage,
  or a fake/demo auth — just build the UI and wire it with these data-attributes:
  • REGISTER form: <form data-zurum="register" data-zurum-redirect="/dashboard"> with
    named inputs name="name", name="email", type="password" name="password", and a
    <p data-zurum-message></p> for inline errors.
  • LOGIN form: <form data-zurum="login" data-zurum-redirect="/dashboard"> with
    name="email", name="password", and a <p data-zurum-message></p>. Include a
    "Forgot password?" FORM near it: <form data-zurum="reset-request"> with a
    name="email" input, a submit button, and a <p data-zurum-message></p> (it
    emails the user a reset link).
  • LOGOUT: any element with data-zurum="logout" (optionally data-zurum-redirect="/").
  • Show the signed-in user's name with <span data-zurum-user></span>.
  • Gate content: data-zurum-auth on elements shown ONLY when logged in;
    data-zurum-guest on elements shown ONLY when logged out.
  • Optional (nice): a small banner with data-zurum-unverified (shown only until
    the user confirms their email) containing a button data-zurum="resend-verification"
    and a <p data-zurum-message></p>. Email confirmation is sent automatically on signup.
- SAVING/READING data (e.g. a dashboard of orders/bookings/notes): use
  window.Zurum.save("collection", {..fields..}) and window.Zurum.list("collection")
  which returns [{id, data, createdAt}]; window.Zurum.update("collection", id, {..})
  and window.Zurum.remove("collection", id) exist too. Render lists from that.
- IMAGE UPLOADS (avatars, listing photos): window.Zurum.upload(fileInput.files[0])
  resolves to {url}; put that url in an <img src> and/or save it via Zurum.save.
  Only image files (PNG/JPG/GIF/WEBP) up to 5MB are accepted.
- STORE / E-COMMERCE (if this is a shop/store): put a single
  <div data-zurum-products></div> in the shop/products section — the Zurum runtime
  fills it with the merchant's REAL products and working "Buy now" buttons (buyers
  pay on the merchant's own secure checkout; the money goes to the merchant). Style
  the surrounding section richly, but let that container hold the product grid. Do
  NOT hardcode fake products, prices or a fake cart — the runtime provides real ones.
- Build the pages the brief implies (e.g. register, login, and a /dashboard that
  shows data-zurum-auth content) as sections/links in this single file.`;

/** Generate a full website for the given spec (optional logo + real photos). */
export function generateSite(
  spec: string,
  signal?: AbortSignal,
  logoDataUri?: string | null,
  palette?: StockPhoto[],
  formEndpoint?: string | null,
  backend?: boolean,
): Promise<ForgeResult> {
  const photos = palette?.length
    ? `\n\nREAL PHOTOS to use (actual URLs — place them in the hero, gallery, cards and ` +
      `section backgrounds; choose the most fitting, you needn't use all):\n` +
      palette.map((p) => `- ${p.url}  (${p.alt})`).join("\n")
    : "";
  const forms = formEndpoint
    ? `\n\nFORM ENDPOINT (use as the action of every form): ${formEndpoint}`
    : "";
  const system = backend ? SYSTEM + BACKEND_BLOCK : SYSTEM;
  return generateDoc(system, `Brief:\n${spec}${photos}${forms}`, "forge-build", signal, logoDataUri);
}

const EDIT_SYSTEM = `You are Forge, editing an EXISTING website. Apply the
customer's requested change to the HTML below and return the COMPLETE, updated
single-file document.

Rules:
- Keep everything the customer did NOT ask to change. Make the smallest change
  that satisfies the request; don't redesign the whole site unless asked.
- Preserve all the same constraints: one self-contained file, embedded CSS/JS,
  NO external resources, responsive, accessible.
- Output ONLY the raw updated HTML, starting exactly with <!DOCTYPE html>. No
  code fences, no commentary.`;

/** Apply a natural-language change to an existing site, returning the new HTML. */
export function editSite(
  currentHtml: string,
  change: string,
  signal?: AbortSignal,
  logoDataUri?: string | null,
): Promise<ForgeResult> {
  return generateDoc(
    EDIT_SYSTEM,
    `Requested change:\n${change}\n\nCurrent website HTML:\n${currentHtml}`,
    "forge-edit",
    signal,
    logoDataUri,
  );
}
