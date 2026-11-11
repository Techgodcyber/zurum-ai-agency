/**
 * Control-plane schema (ARCHITECTURE.md §3B).
 *
 * This is the source of truth: accounts, sites, jobs + checkpoints, the credits
 * ledger, domain/hosting/customer mappings, billing, and audit logs. Kept as a
 * single idempotent SQL script (CREATE ... IF NOT EXISTS) so it can be applied
 * on every boot in dev and run as the first migration in prod. Real Postgres and
 * PGlite (PG15) both accept this verbatim — including gen_random_uuid() and jsonb.
 *
 * When this grows, switch to numbered migration files; for now one script is
 * simplest and safe to re-run.
 */
export const SCHEMA_SQL = /* sql */ `
-- Customers (signup via WhatsApp / Web / Telegram; WhatsApp OTP).
CREATE TABLE IF NOT EXISTS users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text,
  phone        text UNIQUE,
  email        text UNIQUE,
  channel      text NOT NULL DEFAULT 'telegram'
               CHECK (channel IN ('telegram','whatsapp','web')),
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Template/portfolio library (§3A). Dual-purpose: marketing sample + build base.
CREATE TABLE IF NOT EXISTS templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  category    text NOT NULL,
  tags        text[] NOT NULL DEFAULT '{}',
  slots       jsonb NOT NULL DEFAULT '{}'::jsonb,
  demo_url    text,
  thumbnail   text,
  is_public   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Domains bought on the customer's behalf (Namesilo reseller, §3).
CREATE TABLE IF NOT EXISTS domains (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  name        text NOT NULL,
  registrar   text NOT NULL DEFAULT 'namesilo',
  status      text NOT NULL DEFAULT 'pending',
  expiry      date,
  dns_ref     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Customer sites (draft → preview → live → paused).
CREATE TABLE IF NOT EXISTS sites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  name         text,
  category     text,
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','preview','live','paused')),
  plan         text NOT NULL DEFAULT 'static'
               CHECK (plan IN ('static','static_pro','backend')),
  domain_id    uuid REFERENCES domains(id) ON DELETE SET NULL,
  hosting_ref  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Jobs: the unit of orchestration. checkpoint(jsonb) enables crash-resume (§3B/§8).
CREATE TABLE IF NOT EXISTS jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      uuid REFERENCES sites(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  type         text NOT NULL DEFAULT 'build'
               CHECK (type IN ('build','edit','deploy')),
  state        text NOT NULL DEFAULT 'queued'
               CHECK (state IN ('queued','running','awaiting_approval','completed','failed','paused')),
  checkpoint   jsonb NOT NULL DEFAULT '{}'::jsonb,
  input        jsonb NOT NULL DEFAULT '{}'::jsonb,
  retries      integer NOT NULL DEFAULT 0,
  cost_tokens  bigint NOT NULL DEFAULT 0,
  cost_usd     numeric(12,6) NOT NULL DEFAULT 0,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs (state, created_at);

-- Conversations (Scribe/Aria chat, per channel).
CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  site_id     uuid REFERENCES sites(id) ON DELETE SET NULL,
  channel     text NOT NULL,
  messages    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Billing (monthly recurring / annual prepay; §6). Crypto cannot auto-recur.
CREATE TABLE IF NOT EXISTS billing (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  plan         text NOT NULL DEFAULT 'static',
  method       text NOT NULL DEFAULT 'card'
               CHECK (method IN ('card','momo','crypto')),
  recurring    boolean NOT NULL DEFAULT true,
  next_charge  timestamptz,
  status       text NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Edit-credit metering (§6/§9): free allowance then credit packs.
CREATE TABLE IF NOT EXISTS credits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance     integer NOT NULL DEFAULT 0,
  ledger      jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Payments (with fraud score, §4.6).
CREATE TABLE IF NOT EXISTS payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  amount_usd    numeric(12,2) NOT NULL,
  method        text NOT NULL,
  fraud_score   numeric(5,2),
  status        text NOT NULL DEFAULT 'pending',
  provider_ref  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Support tickets with SLA due-times (§9).
CREATE TABLE IF NOT EXISTS support_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  site_id     uuid REFERENCES sites(id) ON DELETE SET NULL,
  tier        text NOT NULL DEFAULT 'general'
              CHECK (tier IN ('abuse','billing','technical','general')),
  sla_due     timestamptz,
  status      text NOT NULL DEFAULT 'open',
  assignee    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Audit log (compliance/security; kept from day one for SOC2 path, §12).
CREATE TABLE IF NOT EXISTS audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor       text,
  action      text NOT NULL,
  target      text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Channel identities → one user. Lets a customer be recognised as the SAME
-- person across Telegram, WhatsApp and (later) web — "one Zurum, not separate
-- bots". Two identities can be merged to link channels for one customer.
CREATE TABLE IF NOT EXISTS identities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel      text NOT NULL,
  external_id  text NOT NULL,        -- sender's stable id on that channel
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);

-- Intake conversations, keyed per channel chat. Holds the Scribe chat history
-- and links to the build job once one is submitted.
CREATE TABLE IF NOT EXISTS intake_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     text NOT NULL,
  chat_id     text NOT NULL,
  phase       text NOT NULL DEFAULT 'intake'
              CHECK (phase IN ('intake','building','awaiting_approval','done')),
  job_id      uuid REFERENCES jobs(id) ON DELETE SET NULL,
  -- Stable per-conversation site identifier: builds/edits write to this so the
  -- customer's preview URL stays the SAME across edits (updates in place).
  site_id     text,
  -- A reference URL awaiting the customer's "is this your site?" answer.
  pending_url text,
  messages    jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, chat_id)
);

-- Per-customer build quota. Stops anyone building unlimited free sites (each
-- build costs real model + hosting money). build_limit NULL = use the global
-- default (env FREE_BUILD_LIMIT); -1 = unlimited (admins/trusted); a number =
-- that customer's cap. builds_used counts NEW sites (edits don't count).
CREATE TABLE IF NOT EXISTS build_quota (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  build_limit  integer,
  builds_used  integer NOT NULL DEFAULT 0,
  edits_used   integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- Free-edit counter (customers get a handful of free edits before credits apply).
ALTER TABLE build_quota ADD COLUMN IF NOT EXISTS edits_used integer NOT NULL DEFAULT 0;

-- One credit wallet per customer. The credits table already exists (below);
-- this unique index makes upserts (grant/spend) safe and one-row-per-user.
CREATE UNIQUE INDEX IF NOT EXISTS credits_user_uidx ON credits (user_id);
-- Low-balance alert: topup_ref = balance right after the last top-up (the "full"
-- reference); low_warned = we've already warned this cycle (reset on next top-up).
ALTER TABLE credits ADD COLUMN IF NOT EXISTS topup_ref integer NOT NULL DEFAULT 0;
ALTER TABLE credits ADD COLUMN IF NOT EXISTS low_warned boolean NOT NULL DEFAULT false;

-- Credit top-ups via a payment provider. One row per attempt, keyed by tx_ref;
-- crediting the wallet is idempotent (only a 'pending' row -> 'paid' grants).
CREATE TABLE IF NOT EXISTS topups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  tx_ref      text UNIQUE NOT NULL,
  credits     integer NOT NULL,
  amount      numeric(14,2) NOT NULL,
  currency    text NOT NULL,
  provider    text NOT NULL DEFAULT 'flutterwave',
  status      text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Fraud/abuse signals on payment attempts (§14.4) — a light audit trail so staff
-- can see flagged top-ups. Never blocks crediting (that's already verified against
-- the provider); this catches card-testing / farming BEFORE a checkout is created.
CREATE TABLE IF NOT EXISTS fraud_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  tx_ref      text,
  score       integer NOT NULL,
  action      text NOT NULL,
  reasons     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fraud_flags_time ON fraud_flags (created_at DESC);

-- ── Admin control center ────────────────────────────────
-- Staff accounts with roles (owner/manager/support/marketer/developer/spectator).
-- Passwords are scrypt hashes; never store plaintext.
CREATE TABLE IF NOT EXISTS staff (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text UNIQUE NOT NULL,
  name           text,
  password_hash  text NOT NULL,
  role           text NOT NULL DEFAULT 'spectator',
  active         boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Server-side sessions for the admin UI (cookie holds only an opaque token).
CREATE TABLE IF NOT EXISTS staff_sessions (
  token       text PRIMARY KEY,
  staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_sessions_expiry_idx ON staff_sessions (expires_at);

-- Light-dynamic tier: real submissions from generated contact/booking forms, so
-- a "static" site can actually capture leads.
CREATE TABLE IF NOT EXISTS form_submissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     text NOT NULL,
  form_name   text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS form_submissions_site_idx ON form_submissions (site_id, created_at DESC);

-- ── Publish tier + state ────────────────────────────────
-- Per-site plan + publish status. A site is built and PREVIEWED for free; going
-- live (the annual host+domain fee) flips it to published with a 1-year expiry.
-- Two plans: 'static' (cheap, Cloudflare) and 'dynamic' (dashboard/portal/app,
-- runs on our server → costs more).
CREATE TABLE IF NOT EXISTS site_publish (
  site_id         text PRIMARY KEY,
  plan            text NOT NULL DEFAULT 'static',
  published       boolean NOT NULL DEFAULT false,
  price_usd       integer,
  pay_ref         text,
  published_at    timestamptz,
  published_until timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expired         boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE site_publish ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE site_publish ADD COLUMN IF NOT EXISTS expired boolean NOT NULL DEFAULT false;

-- Pending/settled publish payments (mirrors the topups table, but marks a site
-- live rather than granting credits). Status flips to paid once, idempotently.
CREATE TABLE IF NOT EXISTS publish_orders (
  tx_ref     text PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  site_id    text NOT NULL,
  plan       text NOT NULL,
  price_usd  integer NOT NULL,
  amount     numeric NOT NULL,
  currency   text NOT NULL,
  status     text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at    timestamptz
);
CREATE INDEX IF NOT EXISTS publish_orders_site_idx ON publish_orders (site_id);

-- Runtime-tunable settings (the in-chat "control center"). Overrides the env
-- defaults for limits + pricing, so the founder can change them live via /set
-- without editing files or restarting.
CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Hosting mapping: stable Zurum site id → the provider site it's deployed to.
-- Keyed by the per-conversation site_id (text) so every edit redeploys to the
-- SAME provider site, keeping the public URL constant across changes.
CREATE TABLE IF NOT EXISTS site_hosting (
  site_id           text PRIMARY KEY,
  provider          text NOT NULL DEFAULT 'netlify',
  provider_site_id  text NOT NULL,
  public_url        text NOT NULL,
  suspended         boolean NOT NULL DEFAULT false,
  suspended_reason  text,
  suspended_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- Per-site kill switch (blast-radius containment, §4.7) — ALTERs for DBs created
-- before these columns existed; the CREATE above covers fresh databases.
ALTER TABLE site_hosting ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;
ALTER TABLE site_hosting ADD COLUMN IF NOT EXISTS suspended_reason text;
ALTER TABLE site_hosting ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

-- The customer's payment currency (detected from WhatsApp phone, or chosen once
-- on Telegram/web) so non-Nigerians aren't charged in Naira.
ALTER TABLE users ADD COLUMN IF NOT EXISTS currency text;

-- Domain purchase tracking (funded-account spend guard, §4.1): what a domain
-- cost us at the registrar + when it was actually registered, so a runaway can't
-- silently drain the reseller wallet. site_id links the domain to its site.
ALTER TABLE domains ADD COLUMN IF NOT EXISTS cost_usd numeric;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS registered_at timestamptz;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS site_id text;

-- Additive migrations (idempotent) for schema evolution without wiping data.
ALTER TABLE intake_conversations ADD COLUMN IF NOT EXISTS site_id text;
-- A reference URL the customer sent, awaiting their "is this yours?" answer.
ALTER TABLE intake_conversations ADD COLUMN IF NOT EXISTS pending_url text;
-- The verified customer this conversation belongs to (from the identities map).
ALTER TABLE intake_conversations ADD COLUMN IF NOT EXISTS user_id uuid;
-- A domain the customer asked us to secure, remembered so we never lose it or
-- pretend we forgot (domain registration itself isn't live yet).
ALTER TABLE intake_conversations ADD COLUMN IF NOT EXISTS pending_domain text;
-- True while we're waiting for the customer to type a custom top-up amount.
ALTER TABLE intake_conversations ADD COLUMN IF NOT EXISTS awaiting_topup boolean NOT NULL DEFAULT false;

-- ── Customer-site backend: the multi-tenant "building block" backend (§14) ──
-- ONE hardened, centrally-patched service that every generated site with logins
-- or a dashboard talks to. The AI never freehands this code — it wires the site
-- to these vetted endpoints. Tenant isolation is by site_id on EVERY row, so a
-- breach of one site can never read another's users or data (§14.4 L4).

-- Per-site backend switch + CORS allow-list (the site's own front-end origins).
CREATE TABLE IF NOT EXISTS site_backend (
  site_id          text PRIMARY KEY,
  enabled          boolean NOT NULL DEFAULT true,
  allowed_origins  text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- End-users who register/login ON a customer's site (NOT Zurum's own customers).
-- Scoped to the site: the same email may exist independently on two sites.
CREATE TABLE IF NOT EXISTS site_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        text NOT NULL,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  name           text,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  UNIQUE (site_id, email)
);
CREATE INDEX IF NOT EXISTS site_users_site ON site_users(site_id);

-- Bearer-token sessions for site end-users. The token is stored HASHED (sha256),
-- so a database leak never hands out live sessions.
CREATE TABLE IF NOT EXISTS site_user_sessions (
  token_hash   text PRIMARY KEY,
  site_id      text NOT NULL,
  user_id      uuid NOT NULL REFERENCES site_users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_user_sessions_user ON site_user_sessions(user_id);

-- Generic per-site records (orders, bookings, submissions, saved items) that
-- power a site's dashboard. owner_user_id (nullable) scopes private records to
-- the end-user who created them.
CREATE TABLE IF NOT EXISTS site_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        text NOT NULL,
  collection     text NOT NULL,
  owner_user_id  uuid REFERENCES site_users(id) ON DELETE CASCADE,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_records_site_coll ON site_records(site_id, collection);

-- Single-use, expiring password-reset tokens for site end-users (stored HASHED).
CREATE TABLE IF NOT EXISTS site_password_resets (
  token_hash   text PRIMARY KEY,
  site_id      text NOT NULL,
  user_id      uuid NOT NULL REFERENCES site_users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  used         boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_password_resets_user ON site_password_resets(user_id);

-- Mark an end-user's email verified (email verification is optional per site).
ALTER TABLE site_users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

-- Single-use, expiring email-verification tokens for site end-users (hashed).
CREATE TABLE IF NOT EXISTS site_email_verifications (
  token_hash   text PRIMARY KEY,
  site_id      text NOT NULL,
  user_id      uuid NOT NULL REFERENCES site_users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  used         boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_email_verifications_user ON site_email_verifications(user_id);

-- Magic-link sessions for the CUSTOMER panel (their own web portal). The link
-- is emailed/messaged from chat; the token is stored hashed and expires. Lets a
-- customer see their sites, download their code, and view their data — the §9
-- "Data & Account" access — without a full password login.
CREATE TABLE IF NOT EXISTS panel_tokens (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Titan business email: one Titan order per domain + provisioned mailboxes ──
CREATE TABLE IF NOT EXISTS mailbox_orders (
  domain          text PRIMARY KEY,
  titan_order_id  bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS site_mailboxes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  domain           text NOT NULL,
  email            text NOT NULL,
  titan_account_id bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);
CREATE INDEX IF NOT EXISTS site_mailboxes_user ON site_mailboxes(user_id);

-- ── Growth engine: privacy-friendly page analytics (no PII) ──
-- One row per pageview. vid is a 1st-party random id (localStorage) for a rough
-- unique-visitor count — never a person's identity. Swept to a retention window.
CREATE TABLE IF NOT EXISTS site_events (
  id          bigserial PRIMARY KEY,
  site_id     text NOT NULL,
  vid         text,
  path        text,
  ref         text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_events_site_time ON site_events(site_id, created_at);

-- ── E-commerce: a customer's site selling to ITS OWN buyers (§14 block) ──
-- Money goes to the MERCHANT (the Zurum customer) via THEIR payment provider.
-- The merchant's secret key is stored ENCRYPTED (crypto-box, MASTER_KEY).
CREATE TABLE IF NOT EXISTS site_payment_config (
  site_id     text PRIMARY KEY,
  provider    text NOT NULL DEFAULT 'flutterwave',
  secret_enc  text,            -- the merchant's provider secret, encrypted
  currency    text NOT NULL DEFAULT 'NGN',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     text NOT NULL,
  name        text NOT NULL,
  price       numeric NOT NULL,
  currency    text NOT NULL DEFAULT 'NGN',
  image_url   text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_products_site ON site_products(site_id);

CREATE TABLE IF NOT EXISTS site_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      text NOT NULL,
  tx_ref       text UNIQUE NOT NULL,
  items        jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount       numeric NOT NULL,
  currency     text NOT NULL,
  buyer_name   text,
  buyer_email  text,
  buyer_phone  text,
  status       text NOT NULL DEFAULT 'pending',   -- pending | paid | failed
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz
);
CREATE INDEX IF NOT EXISTS site_orders_site ON site_orders(site_id);

-- One-time WhatsApp login codes for the customer web login (phone → OTP). The
-- code is stored HASHED; one active code per phone (re-send overwrites).
CREATE TABLE IF NOT EXISTS login_otps (
  phone       text PRIMARY KEY,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Files uploaded by a site's end-users (avatars, listing photos, …). Validated
-- by MAGIC BYTES, stored with a random key, and served back with a fixed image
-- content-type + nosniff so an upload can never execute as code (§14.4 L2).
CREATE TABLE IF NOT EXISTS site_uploads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        text NOT NULL,
  owner_user_id  uuid REFERENCES site_users(id) ON DELETE CASCADE,
  mime           text NOT NULL,
  size           integer NOT NULL,
  storage_key    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_uploads_site ON site_uploads(site_id);

-- ── Zurum Personal (companion product) — see PERSONAL_ARCHITECTURE.md ──
-- One row per Personal user, extending the shared users table with their chosen
-- mode (glued to their number), companion name, tier, and subscription state.
-- The active_mode binding is what "sticks" a friend/companion/tutor/… to a number.
CREATE TABLE IF NOT EXISTS personal_users (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_mode      text,                              -- null until they pick one
  persona_name     text,                              -- what they call their companion
  tier             text NOT NULL DEFAULT 'free',      -- free | sub
  adult_opt_in     boolean NOT NULL DEFAULT false,    -- 18+ attested (romantic/SFW warmth)
  adult_opt_in_at  timestamptz,
  sub_status       text NOT NULL DEFAULT 'none',      -- none | active | past_due | cancelled
  sub_renews_at    timestamptz,
  -- Relationship progression (§4): interaction volume drives the familiarity
  -- stage that warms the persona over time — remembered context, not faked emotion.
  msg_count        integer NOT NULL DEFAULT 0,
  last_seen_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Self-healing migrations: these columns were added after personal_users first
-- shipped, so an existing table (dev or prod) needs them ALTERed in — CREATE ...
-- IF NOT EXISTS never adds columns to a table that already exists.
ALTER TABLE personal_users ADD COLUMN IF NOT EXISTS msg_count integer NOT NULL DEFAULT 0;
ALTER TABLE personal_users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE personal_users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
-- Companion creation: the user designs their OWN companion (gender + vibe + name),
-- so a custom character is built from their choices instead of a fixed default.
ALTER TABLE personal_users ADD COLUMN IF NOT EXISTS companion_gender text;   -- female | male
ALTER TABLE personal_users ADD COLUMN IF NOT EXISTS companion_vibe text;     -- playful | romantic | calm | emotional
ALTER TABLE personal_users ADD COLUMN IF NOT EXISTS awaiting_name boolean NOT NULL DEFAULT false;
-- The user's OWN name (what the companion calls them) + its capture state.
ALTER TABLE personal_users ADD COLUMN IF NOT EXISTS user_name text;
ALTER TABLE personal_users ADD COLUMN IF NOT EXISTS awaiting_user_name boolean NOT NULL DEFAULT false;
-- The companion's chosen voice id (from the voice roster); null = gender default.
ALTER TABLE personal_users ADD COLUMN IF NOT EXISTS companion_voice text;

-- Short-term conversation buffer for Personal (recent turns → continuity). Durable
-- long-term memory (facts + summary) lands in Sprint 3; this is the rolling window.
CREATE TABLE IF NOT EXISTS personal_messages (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL,                          -- 'user' | 'assistant'
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS personal_messages_user_time ON personal_messages(user_id, created_at DESC);

-- ── Zurum Personal memory engine (Sprint 3) — the "User Profile", not a chat log ──
-- Durable, TYPED memories about the person, each with an importance ★ (1–5) so the
-- companion keeps what matters and lets trivia fade. mem_key is an optional
-- normalized handle (e.g. 'birthday') so a restated fact UPDATES, not duplicates.
CREATE TABLE IF NOT EXISTS personal_memory (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,   -- fact|preference|goal|person|dream|fear|achievement|favorite|date|schedule|taste|boundary
  content     text NOT NULL,
  salience    integer NOT NULL DEFAULT 3,   -- 1..5 importance
  mem_key     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, mem_key)                 -- null keys are distinct, so keyless memories never collide
);
CREATE INDEX IF NOT EXISTS personal_memory_user ON personal_memory(user_id, salience DESC, updated_at DESC);

-- A rolling natural-language digest of who the person is (the "understanding").
CREATE TABLE IF NOT EXISTS personal_summary (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  summary     text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Real, logged relationship milestones (never fabricated) — one per kind per user.
CREATE TABLE IF NOT EXISTS personal_milestones (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,    -- first_chat | chats_50 | chats_100 | one_week | one_month | one_year | ...
  reached_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind)
);

-- ── Zurum Personal billing (Sprint 4) ──
-- Free-tier daily text counter. Subscription state lives on personal_users
-- (sub_status + sub_renews_at); voice credits reuse the shared credits wallet --
-- the sub (text entitlement) and credits (voice) are deliberately separate.
CREATE TABLE IF NOT EXISTS personal_daily_usage (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day         date NOT NULL DEFAULT CURRENT_DATE,
  text_count  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- FREE voice seconds consumed per day (Sprint 5). Total free + daily drip caps are
-- runtime settings; paid voice goes to the credits wallet, not this table.
CREATE TABLE IF NOT EXISTS personal_voice_usage (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day         date NOT NULL DEFAULT CURRENT_DATE,
  seconds     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- ── Job-hunt agent (src/jobhunt) ───────────────────────────────────────────
-- Every posting the agent has ever seen, from any source. Upserted on each
-- scan so re-running is cheap and scores stay current.
CREATE TABLE IF NOT EXISTS job_listings (
  id           text PRIMARY KEY,            -- "<source>:<externalId>"
  source       text NOT NULL,
  external_id  text NOT NULL,
  title        text NOT NULL,
  company      text NOT NULL,
  company_key  text NOT NULL,               -- normalised, drives the cooldown
  location     text,
  remote       boolean NOT NULL DEFAULT true,
  url          text NOT NULL,
  apply_url    text,
  apply_email  text,
  salary       text,
  tags         jsonb NOT NULL DEFAULT '[]'::jsonb,
  description  text NOT NULL DEFAULT '',
  posted_at    timestamptz,
  score        integer,
  score_reason text,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_listings_score_idx ON job_listings(score DESC);
CREATE INDEX IF NOT EXISTS job_listings_company_idx ON job_listings(company_key);

-- One application per listing. UNIQUE(listing_id) is what stops the agent from
-- ever writing to the same role twice, however many times a scan re-finds it.
CREATE TABLE IF NOT EXISTS job_applications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  text NOT NULL UNIQUE REFERENCES job_listings(id) ON DELETE CASCADE,
  company_key text NOT NULL,
  channel     text NOT NULL DEFAULT 'email',   -- email | manual
  to_email    text,
  subject     text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'draft',   -- draft|queued|sent|manual|skipped|failed
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS job_applications_status_idx ON job_applications(status);
CREATE INDEX IF NOT EXISTS job_applications_sent_idx ON job_applications(sent_at);

-- Never write to these again. Populated by hand and by any "no thanks" reply.
CREATE TABLE IF NOT EXISTS job_suppression (
  company_key text PRIMARY KEY,
  email       text,
  reason      text,
  added_at    timestamptz NOT NULL DEFAULT now()
);
`;
