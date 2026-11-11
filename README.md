# AI Web Agency

Telegram/WhatsApp-native AI web agency: a customer describes an idea, an AI agent
team builds the site, buys the domain, hosts it, and supports it.

This repo is the implementation, built in slices.

## Stack

- **Runtime:** Node 20+ / TypeScript (ESM)
- **Models:** Claude (primary) + Kimi (design), fallbacks Gemini + DeepSeek — routed per agent
- **(coming):** Postgres + Redis (BullMQ), Telegram (grammY), Coolify + Cloudflare, Namesilo

## Getting started

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY (others optional)
npm run typecheck         # verify the build compiles
npm run smoke:router      # verify the model-router + failover ladder
npm run dev               # boot (foundation slice)
```

## Build progress

- [x] **Foundation** — project scaffold, validated env config, structured logging
- [x] **Model-router (§8)** — provider abstraction, per-agent failover ladder,
      retry/backoff, cost instrumentation, prompt caching
  - [x] Anthropic provider (Opus 4.8 / Sonnet 5 / Haiku 4.5 — adaptive thinking,
        effort, caching, streaming)
  - [ ] Kimi / Gemini / DeepSeek providers (pending — currently skipped by router)
- [x] **Control-plane (§3B)** — PGlite (dev) / Postgres (prod) swappable adapter,
      full schema, job store with checkpoints, in-process queue (BullMQ+Redis in prod)
- [x] **Maestro orchestration loop** — pipeline runner, per-step checkpointing +
      crash-resume, human-approval gate, runaway sentinel (step/cost/time caps)
- [x] **Channel-agnostic core** — `Channel` interface + hub; **Telegram adapter
      LIVE** (grammY); **WhatsApp adapter reserved** (same interface, pending Meta/BSP)
- [x] **Scribe** (first live agent) — multi-turn intake → build spec, conversation
      store, wired to Maestro with approval-gate + go-live notifications back to the customer
- [x] **Quick-action buttons** — channel-agnostic actions; Telegram inline
      buttons live (Approve / Request change); WhatsApp reply-buttons ready
- [x] **Forge** (the builder) — generates a REAL self-contained website from the
      spec (embedded CSS/JS, no external deps), served by a local preview server
      (LAN-accessible) so the preview link opens an actual page
- [x] **Guardian** — QA + self-containment/security checks + AI content
      moderation gate before preview (blocks broken sites, external-resource
      leaks, and phishing/impersonation; verified live)
- [x] **Aria** — post-preview support agent: classifies intent (edit / new site /
      approve / send-my-link / chat) in any language and replies naturally, with a
      keyword fallback so build requests are never swallowed
- [x] **Logo upload** (image → embedded in the site, never sent to the model) ·
      **stable site URL** across edits · **URL reference builds** (own site =
      exact rebuild, third-party = style inspiration only)
- [ ] **Launch** — real domain purchase + Coolify hosting + DNS/SSL (needs VPS/
      Cloudflare/Namesilo accounts). Architecture is ready for it to slot in.
- [ ] Real stock images (Pexels/Unsplash/Pixabay) · vision rebuild from
      screenshots · credits/billing · WhatsApp adapter
- [ ] Sandbox (hardened Docker) for Forge builds
- [ ] Deploy (Coolify) + domain (Namesilo) + DNS/SSL/email (Cloudflare)
- [ ] Customer dashboard + admin control center
- [ ] Anti-abuse / preview protection · billing · monitoring

## Layout

```
src/
  config/env.ts          validated environment
  lib/logger.ts          structured logging
  models/
    types.ts             provider-agnostic contracts
    routing.ts           role → model ladder + price book
    router.ts            failover ladder (retry → fallback → exhaust)
    providers/           anthropic (live) · pending (kimi/gemini/deepseek)
  db/
    schema.ts            control-plane schema (§3B)
    adapter.ts           PGlite (dev) / Postgres (prod)
    jobs.ts              job store + checkpoints
  queue/                 job queue interface + in-process dev impl
  orchestrator/
    maestro.ts           the orchestration loop (checkpoint / resume / sentinel)
    pipeline.ts          the build pipeline (agent steps — stubs today)
  index.ts               entry point
scripts/
  smoke-router.ts        end-to-end router check
  smoke-orchestrator.ts  end-to-end orchestration check
```
