import type { AgentRole, Effort, ModelSpec, ProviderName } from "./types.js";

/**
 * Model routing table + price book (ARCHITECTURE.md §8, §10).
 *
 * Each agent role has a PRIMARY model and an ordered list of FALLBACKS the
 * router walks if the primary is unavailable or keeps failing. Primaries are
 * Claude + Kimi; fallbacks are Gemini + DeepSeek (never GPT — founder's choice).
 *
 * Cost strategy (§10): put high-volume/simple agents on the cheapest capable
 * model (Haiku), orchestration/QA on Sonnet, and only the hardest Forge builds
 * on Opus. That is what keeps compute ≤ ~$1–2 per static build.
 *
 * NOTE: non-Anthropic model IDs are best-effort placeholders — confirm the exact
 * strings against each provider's current docs before production. They live here
 * so a change is one edit, not a code hunt.
 */

// ── Model IDs ────────────────────────────────────────────
export const MODELS = {
  // Anthropic (authoritative IDs).
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5",
  // Kimi / Moonshot. Measured latency (short prompt): k3 ~14s, k2.7-code ~7.5s,
  // highspeed ~1s. So highspeed is the default for chat/voice AND Forge — it's
  // both fast and code-capable. k3/k2.7-code kept only as deeper fallbacks.
  kimi: "kimi-k2.7-code-highspeed",
  kimiCode: "kimi-k2.7-code",
  kimiCodeFast: "kimi-k2.7-code-highspeed",
  kimiFlagship: "kimi-k3",
  // Gemini (confirm before prod).
  geminiPro: "gemini-2.0-flash",
  geminiFlash: "gemini-2.0-flash",
  // DeepSeek (confirm before prod).
  deepseekChat: "deepseek-chat",
  // OpenAI (ChatGPT). Confirm the exact id your account has access to.
  openai: "gpt-4o",
  openaiMini: "gpt-4o-mini",
  deepseekReasoner: "deepseek-reasoner",
} as const;

/** USD per 1,000,000 tokens, keyed by `provider:model`. */
export const PRICE_BOOK: Record<string, { input: number; output: number }> = {
  "anthropic:claude-opus-4-8": { input: 5, output: 25 },
  "anthropic:claude-sonnet-5": { input: 3, output: 15 },
  "anthropic:claude-haiku-4-5": { input: 1, output: 5 },
  "anthropic:claude-fable-5": { input: 10, output: 50 },
  // Placeholders — real cost is on the Moonshot dashboard; update when known.
  "kimi:kimi-k3": { input: 0.6, output: 2.5 },
  "kimi:kimi-k2.7-code": { input: 0.6, output: 2.5 },
  "kimi:kimi-k2.7-code-highspeed": { input: 0.6, output: 2.5 },
  "openai:gpt-4o": { input: 2.5, output: 10 },
  "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gemini:gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "deepseek:deepseek-chat": { input: 0.28, output: 1.1 },
  "deepseek:deepseek-reasoner": { input: 0.55, output: 2.2 },
};

const spec = (
  provider: ProviderName,
  model: string,
  effort?: Effort,
): ModelSpec => ({ provider, model, effort });

interface RouteEntry {
  primary: ModelSpec;
  fallbacks: ModelSpec[];
}

// Kimi is funded and OpenAI-compatible; it's the working fallback for every
// Anthropic-primary role, so the whole product keeps running if Anthropic is
// unavailable (e.g. out of credit). When Anthropic is funded, primaries win.
const kimi = spec("kimi", MODELS.kimi);
const gpt = spec("openai", MODELS.openai, "high");
const gptMini = spec("openai", MODELS.openaiMini, "medium");

/**
 * The routing ladder for every agent role. Each role tries its primary, then
 * falls through the alternates — so an outage, rate-limit or empty balance on
 * one provider is absorbed automatically.
 */
export const ROUTES: Record<AgentRole, RouteEntry> = {
  maestro: {
    primary: spec("anthropic", MODELS.sonnet, "high"),
    fallbacks: [kimi, gpt, spec("gemini", MODELS.geminiPro, "high"), spec("deepseek", MODELS.deepseekReasoner, "high")],
  },
  scribe: {
    primary: spec("anthropic", MODELS.haiku, "medium"),
    fallbacks: [kimi, gptMini, spec("gemini", MODELS.geminiFlash, "medium")],
  },
  "forge-design": {
    // QUALITY-first for design: Claude Sonnet is the best web-design model by a
    // clear margin and Anthropic is now funded. Full kimi-k2.7-code is the strong,
    // cheap fallback; highspeed/gpt/gemini after that. The 90s timeout keeps any
    // single provider hiccup from stalling a build.
    primary: spec("anthropic", MODELS.sonnet, "high"),
    fallbacks: [
      spec("kimi", MODELS.kimiCode, "high"),
      spec("kimi", MODELS.kimiCodeFast, "high"),
      gpt,
      spec("gemini", MODELS.geminiPro, "high"),
    ],
  },
  "forge-logic": {
    primary: spec("anthropic", MODELS.opus, "xhigh"),
    fallbacks: [spec("anthropic", MODELS.sonnet, "xhigh"), kimi, gpt, spec("deepseek", MODELS.deepseekReasoner, "high")],
  },
  guardian: {
    primary: spec("anthropic", MODELS.sonnet, "high"),
    // Moderation needs good instruction-following; prefer stronger models here
    // so BLOCK/OK verdicts are reliable (highspeed models are poor at this).
    fallbacks: [gpt, spec("kimi", MODELS.kimiCode), spec("gemini", MODELS.geminiPro, "high"), spec("deepseek", MODELS.deepseekReasoner, "high")],
  },
  launch: {
    primary: spec("anthropic", MODELS.haiku, "low"),
    fallbacks: [kimi, gptMini, spec("deepseek", MODELS.deepseekChat, "low")],
  },
  aria: {
    primary: spec("anthropic", MODELS.haiku, "medium"),
    fallbacks: [kimi, gptMini, spec("deepseek", MODELS.deepseekChat, "low")],
  },
  // Zurum Personal — everyday companion chat. High-volume, so cheapest capable
  // model first (protects the $5 margin); warmth beats raw reasoning here.
  companion: {
    primary: spec("anthropic", MODELS.haiku, "medium"),
    fallbacks: [kimi, gptMini, spec("gemini", MODELS.geminiFlash, "medium"), spec("deepseek", MODELS.deepseekChat, "low")],
  },
  // Zurum Personal — emotionally nuanced or complex moments. Premium model for
  // depth; the router escalates to this only when a turn needs it.
  "companion-deep": {
    primary: spec("anthropic", MODELS.sonnet, "high"),
    fallbacks: [kimi, gpt, spec("gemini", MODELS.geminiPro, "high"), spec("deepseek", MODELS.deepseekReasoner, "high")],
  },
  // Job-hunt agent. Quality over cost: this writes in your name to people who
  // may hire you, and the no-fabrication rule needs good instruction-following,
  // which the cheap/highspeed models are unreliable at. Volume is a handful of
  // calls a day, so Sonnet is affordable here.
  "jobhunt-write": {
    primary: spec("anthropic", MODELS.sonnet, "high"),
    fallbacks: [kimi, gpt, spec("gemini", MODELS.geminiPro, "high"), spec("deepseek", MODELS.deepseekReasoner, "high")],
  },
};

/** Ordered ladder (primary first) for a role. */
export function ladderFor(role: AgentRole): ModelSpec[] {
  const entry = ROUTES[role];
  return [entry.primary, ...entry.fallbacks];
}

/** Compute approximate USD cost for a call from the price book. */
export function priceOf(
  spec: ModelSpec,
  inputTokens: number,
  outputTokens: number,
): number {
  const key = `${spec.provider}:${spec.model}`;
  const rate = PRICE_BOOK[key];
  if (!rate) return 0;
  return (
    (inputTokens / 1_000_000) * rate.input +
    (outputTokens / 1_000_000) * rate.output
  );
}
