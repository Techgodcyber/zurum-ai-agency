import "dotenv/config";
import { z } from "zod";

/**
 * Centralised, validated environment configuration.
 *
 * Provider API keys are all optional at this stage: the model-router treats a
 * missing key as "this provider is unavailable" and simply skips it in the
 * failover ladder (§8). At least one working provider is required at runtime,
 * which the router asserts when a role is actually invoked — not at boot — so
 * partial local setups (e.g. Anthropic only) still start.
 */
/** Optional secret: blank or missing → undefined (so empty .env lines are fine). */
const optionalKey = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().min(1).optional(),
);

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // Model providers — all optional; router skips absent ones.
  ANTHROPIC_API_KEY: optionalKey,
  KIMI_API_KEY: optionalKey,
  GEMINI_API_KEY: optionalKey,
  DEEPSEEK_API_KEY: optionalKey,
  OPENAI_API_KEY: optionalKey,
  // Base URLs for the OpenAI-compatible providers (override if needed).
  KIMI_BASE_URL: z.string().default("https://api.moonshot.ai/v1"),
  DEEPSEEK_BASE_URL: z.string().default("https://api.deepseek.com/v1"),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  GEMINI_BASE_URL: z
    .string()
    .default("https://generativelanguage.googleapis.com/v1beta/openai"),

  // Extra approved widget hosts (comma-separated), e.g. a live-chat provider a
  // customer uses that isn't in the built-in list. No redeploy needed.
  EXTRA_EMBED_HOSTS: optionalKey,

  // Stock image providers (real photos instead of drawn shapes).
  PEXELS_API_KEY: optionalKey,
  UNSPLASH_ACCESS_KEY: optionalKey,
  PIXABAY_API_KEY: optionalKey,

  // Titan business email (partner API) — provisions real mailboxes like
  // support@theircompany.com on the customer's domain. Gated on TITAN_API_KEY:
  // absent → the feature reports "coming soon". Get the key + partner details
  // from titan.email/partners. Plan "free" needs no billing fields.
  TITAN_API_KEY: optionalKey,
  TITAN_API_URL: z.string().default("https://bll.titan.email/partner"),
  TITAN_PLAN: z.enum(["free", "pro", "premium", "ultra"]).default("free"),

  // Master key for encrypting stored secrets at rest (e.g. a merchant's payment
  // provider key for e-commerce). Any long random string; without it, features
  // that must store a secret refuse to (fail safe). Generate: openssl rand -hex 32.
  MASTER_KEY: optionalKey,

  // Voice-note transcription (speech-to-text). Prefers a Whisper endpoint —
  // Groq's is fast + has a generous FREE tier (just needs a free key) — and
  // falls back to Gemini audio if that's funded. Absent → voice notes get a
  // friendly "please type it" reply. Works with any OpenAI-compatible Whisper
  // API (Groq default, or set the base URL to OpenAI's).
  WHISPER_API_KEY: optionalKey,
  WHISPER_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
  WHISPER_MODEL: z.string().default("whisper-large-v3"),
  // Text-to-speech for Zurum Personal voice notes. OpenAI-compatible /audio/speech
  // by default (tts-1); swap the base URL + key for ElevenLabs etc. for a premium
  // voice. Falls back to the OpenAI key/base when the VOICE_* overrides are unset.
  VOICE_TTS_KEY: optionalKey,
  VOICE_TTS_BASE_URL: optionalKey,
  VOICE_TTS_MODEL: z.string().default("tts-1-hd"),
  VOICE_TTS_VOICE: z.string().default("alloy"),
  // Premium human voice via ElevenLabs (companion bonding). Set VOICE_PROVIDER
  // to "elevenlabs" and paste ELEVENLABS_API_KEY to activate. Gender maps to a
  // warm default voice id (override to any voice from your ElevenLabs library).
  VOICE_PROVIDER: z.enum(["openai", "elevenlabs", "hume"]).default("openai"),
  ELEVENLABS_API_KEY: optionalKey,
  // multilingual_v2 is more expressive/emotional than turbo (quality > speed for a companion).
  ELEVENLABS_MODEL: z.string().default("eleven_multilingual_v2"),
  // Warm, young, CONVERSATIONAL voices — the right fit for a companion (not narrators).
  ELEVENLABS_VOICE_FEMALE: z.string().default("cgSgspJ2msm6clMCkdW9"), // Jessica — playful, bright, warm
  ELEVENLABS_VOICE_MALE: z.string().default("bIHbv24MWmeRgasZH58o"), // Will — relaxed, warm optimist
  // Hume Octave — emotionally expressive TTS. Steered by a natural-language voice
  // description (default) or a saved Hume voice name (set HUME_VOICE_*). Outputs
  // mp3, so on Telegram it plays as an audio clip, not a voice bubble.
  HUME_API_KEY: optionalKey,
  HUME_VOICE_FEMALE: z.string().default(""), // optional Hume voice name/id
  HUME_VOICE_MALE: z.string().default(""),
  // Vision (understanding screenshots/photos). VISION_PROVIDER picks which is
  // tried FIRST — "gemini" (cheapest, once you have a working Google key) or
  // "claude" (default; uses cheap Haiku). The other is the automatic fallback.
  // Vision only runs when a customer sends an image, so cost is bounded.
  VISION_PROVIDER: z.enum(["claude", "gemini"]).default("claude"),
  VISION_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  GEMINI_VISION_MODEL: z.string().default("gemini-2.0-flash"),

  // Control plane. If DATABASE_URL is set, use real Postgres (prod); otherwise
  // fall back to embedded PGlite persisted under PGLITE_DIR (local dev).
  DATABASE_URL: optionalKey,
  PGLITE_DIR: z.string().default("./.data/pglite"),

  // Channels. Telegram is live (free BotFather token, long-poll — no public URL).
  TELEGRAM_BOT_TOKEN: optionalKey,
  // Zurum Personal runs on its OWN Telegram bot (a second BotFather token) so the
  // companion product stays isolated from the business bot. Self-disables if unset.
  PERSONAL_TELEGRAM_BOT_TOKEN: optionalKey,
  // The Personal bot's @username (no @), used to build shareable t.me links for the
  // roast "share" viral loop. Optional — the CTA just omits the link if unset.
  PERSONAL_BOT_USERNAME: z.string().default(""),

  // WhatsApp via Meta's WhatsApp Cloud API (direct — no BSP). Sending needs the
  // access token + Phone Number ID. RECEIVING needs Meta to reach a public
  // webhook (the VPS domain in prod): Meta first GETs it to verify (echoing
  // hub.challenge when hub.verify_token matches WHATSAPP_VERIFY_TOKEN), then POSTs
  // messages. WHATSAPP_APP_SECRET (optional) verifies the X-Hub-Signature-256 so
  // only Meta can post. WHATSAPP_WEBHOOK_TOKEN is a secret segment in the path.
  WHATSAPP_TOKEN: optionalKey, // access token (secret — never log)
  WHATSAPP_PHONE_NUMBER_ID: optionalKey,
  WHATSAPP_WABA_ID: optionalKey,
  WHATSAPP_VERIFY_TOKEN: z.string().default("zurum-verify"),
  WHATSAPP_APP_SECRET: optionalKey,
  WHATSAPP_WEBHOOK_TOKEN: z.string().default("hook"),
  WHATSAPP_API_VERSION: z.string().default("v21.0"),
  // The public WhatsApp number customers message (digits + country code, e.g.
  // 2349169464811) — used for the web-login "message us to get your code" link.
  WHATSAPP_PUBLIC_NUMBER: optionalKey,

  // Preview server. Serves Forge-generated sites so preview links are real.
  // PUBLIC_BASE_URL overrides the auto-detected LAN address (e.g. a tunnel URL).
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: optionalKey,

  // Hosting. Sites deploy to a real public host so every site gets a globally-
  // served URL the customer can open and share. Cloudflare Pages is preferred
  // when configured (free unlimited bandwidth); Netlify is the fallback. Absent
  // → LAN preview only.
  NETLIFY_TOKEN: optionalKey,
  CLOUDFLARE_API_TOKEN: optionalKey,
  CLOUDFLARE_ACCOUNT_ID: optionalKey,

  // Domain registrar (Namesilo reseller). When NAMESILO_API_KEY is set the bot
  // can check availability + live prices and (once billing is wired) register
  // domains on the customer's behalf. Absent → domain requests are captured and
  // answered honestly ("registration launching soon") but not fulfilled.
  NAMESILO_API_KEY: optionalKey,
  NAMESILO_BASE_URL: z.string().default("https://www.namesilo.com/api"),

  // Build metering. Each customer gets FREE_BUILD_LIMIT free NEW websites before
  // they must upgrade — stops anyone racking up unlimited builds on your dime.
  // Default 2 (the free hook; buy more sites / a plan beyond that).
  // 0 = enforcement OFF (unlimited for everyone). Per-customer overrides live in
  // the build_quota table. ADMIN_IDENTITIES ("telegram:12345,telegram:678") are
  // unlimited AND may run the in-chat admin commands (/limit, /quota).
  FREE_BUILD_LIMIT: z.coerce.number().int().min(0).default(2),
  ADMIN_IDENTITIES: optionalKey,

  // Edit-credit metering. Customers get FREE_EDIT_LIMIT free edits, then each
  // edit costs EDIT_COST_CREDITS and each extra site costs BUILD_COST_CREDITS
  // from their credit wallet. Top-ups convert at CREDITS_PER_USD (so a $5 top-up
  // = 5 × CREDITS_PER_USD credits), minimum MIN_TOPUP_USD.
  FREE_EDIT_LIMIT: z.coerce.number().int().min(0).default(15),
  // Warn the customer to top up once their balance drops to this % of their last
  // top-up (default 30% left = 70% used) — so they're never cut off unaware.
  LOW_CREDIT_PERCENT: z.coerce.number().int().min(1).max(100).default(30),
  EDIT_COST_CREDITS: z.coerce.number().int().min(1).default(1),
  BUILD_COST_CREDITS: z.coerce.number().int().min(1).default(10),
  CREDITS_PER_USD: z.coerce.number().int().min(1).default(10),
  MIN_TOPUP_USD: z.coerce.number().int().min(1).default(5),
  // Annual publish fee (host + domain), charged when a customer takes a site
  // live. Two tiers: a plain static site vs a dynamic one (dashboard/portal/app),
  // which costs more because it runs on our server. Tunable live from admin.
  PUBLISH_PRICE_STATIC_USD: z.coerce.number().int().min(1).default(55),
  PUBLISH_PRICE_DYNAMIC_USD: z.coerce.number().int().min(1).default(120),
  // Free previews carry a "Preview — Built with Zurum" banner (removed on
  // publish). Optionally they also expire: after this many hours an unpaid
  // preview is replaced with a "publish to restore" page. 0 = never expire.
  PREVIEW_EXPIRY_HOURS: z.coerce.number().int().min(0).default(0),
  // Charge currency + USD→NGN rate for Nigerian-priced top-ups (Flutterwave
  // settles in NGN). ngn_per_usd is tunable live via the control center.
  PAY_CURRENCY: z.string().default("NGN"),
  NGN_PER_USD: z.coerce.number().int().min(1).default(1600),

  // Payment providers for credit top-ups (all optional). Flutterwave covers card
  // + bank transfer + USSD on its hosted checkout. Absent → top-ups are captured
  // as "coming soon".
  PAYSTACK_SECRET_KEY: optionalKey,
  FLUTTERWAVE_SECRET_KEY: optionalKey,
  FLUTTERWAVE_BASE_URL: z.string().default("https://api.flutterwave.com/v3"),
  // Where Flutterwave sends the customer AFTER paying (cosmetic — they return to
  // chat and tap "I've paid"). Set to your bot/site link.
  FLUTTERWAVE_REDIRECT_URL: z.string().default("https://t.me"),
  USDT_WALLET_ADDRESS: optionalKey,
  USDT_NETWORK: z.string().default("TRC20"),

  // FX rates for charging non-NGN customers in their own currency. Sign up at
  // exchangerate-api.com (free tier). Absent → only NGN + USD are offered.
  FX_API_KEY: optionalKey,
  FX_BASE_URL: z.string().default("https://v6.exchangerate-api.com/v6"),

  // ── Admin control centre security ─────────────────────
  // Secret URL prefix for the admin centre. Bots hammer /admin, /wp-admin etc.,
  // so in production set something unguessable (e.g. /c-8f3k2p9x). Anything that
  // isn't this exact prefix 404s, so the panel is invisible to scanners.
  // NOTE: obscurity is a NOISE filter, not a lock — the real controls are the
  // login lockout below, strong passwords, and (optionally) the IP allowlist.
  ADMIN_PATH: z
    .string()
    .default("/admin")
    .transform((p) => `/${p.replace(/^\/+|\/+$/g, "")}`),
  // Optional: only these IPs may reach the admin centre at all (comma-separated).
  // Everything else 404s. Strongest single control if your team has fixed IPs.
  ADMIN_IP_ALLOWLIST: optionalKey,
  // Failed logins before an IP/account is locked out, and for how long.
  ADMIN_MAX_LOGIN_ATTEMPTS: z.coerce.number().int().min(3).default(5),
  ADMIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),

  // Transactional email (customer-site password resets + verification). Uses
  // Resend's HTTP API (no dependency). Gated: if RESEND_API_KEY is unset, email
  // features report "not configured" rather than failing. EMAIL_FROM must be an
  // address on a domain verified in Resend (e.g. no-reply@zurum.co).
  RESEND_API_KEY: optionalKey,
  EMAIL_FROM: z.string().default("Zurum <no-reply@zurum.co>"),

  // ── Job-hunt agent (src/jobhunt) ──────────────────────────────────────
  // Applications are written from this file, verbatim, and nothing outside it
  // is ever claimed. Point it at the resume you actually want sent.
  JOBHUNT_RESUME_PATH: z.string().default("./.data/resume.md"),
  // Company career boards to poll, as {"greenhouse":["slug"],"lever":["slug"]}.
  JOBHUNT_BOARDS_PATH: z.string().default("./src/jobhunt/boards.json"),
  // Identity used in the signature. Must match the resume.
  JOBHUNT_NAME: z.string().default(""),
  JOBHUNT_SITE: z.string().default(""),
  JOBHUNT_GITHUB: z.string().default(""),
  JOBHUNT_REPLY_TO: z.string().default(""),
  // Send identity. Leave unset to reuse EMAIL_FROM. Use a subdomain you are
  // willing to burn (e.g. jobs@apply.techgod.space) so a spam complaint never
  // touches the domain your product mail goes out on.
  JOBHUNT_FROM: z.string().default(""),
  // Ceiling once the warm-up ramp is finished. The ramp itself is in outbox.ts.
  JOBHUNT_DAILY_CAP: z.coerce.number().int().min(1).max(50).default(12),
  // Never write to the same company twice inside this many days.
  JOBHUNT_COMPANY_COOLDOWN_DAYS: z.coerce.number().int().min(1).default(90),
  // Deterministic screen threshold (0-100) before a listing is worth drafting.
  JOBHUNT_MIN_SCORE: z.coerce.number().int().min(0).max(100).default(38),
  // Most drafts to write per scan. Each one is a model call.
  JOBHUNT_DRAFT_LIMIT: z.coerce.number().int().min(1).max(50).default(8),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail loud and early on genuinely malformed config.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export type Env = typeof env;

/** True when at least one model provider key is configured. */
export const hasAnyProvider = Boolean(
  env.ANTHROPIC_API_KEY ||
    env.KIMI_API_KEY ||
    env.GEMINI_API_KEY ||
    env.DEEPSEEK_API_KEY,
);
