/**
 * Shared model-layer types.
 *
 * The router (see ./router.ts) sits between the six agents and the underlying
 * LLM providers. Agents never name a concrete model — they call the router with
 * an `AgentRole`, and the routing table maps that role to a primary model plus
 * ordered fallbacks. This keeps provider choice, cost tuning, and failover in
 * one place (ARCHITECTURE.md §8 / §3B).
 */

/** Logical role that requests a completion. Maps to a routing entry. */
export type AgentRole =
  | "maestro" // orchestration / logic
  | "scribe" // intake + vision (customer chat)
  | "forge-design" // UI / visual generation
  | "forge-logic" // code / backend generation
  | "guardian" // QA / security / content moderation
  | "launch" // deploy / domain (light tool-calling)
  | "aria" // support / edits (high-volume, cheap)
  | "companion" // Zurum Personal — everyday companion chat (cost-efficient)
  | "companion-deep" // Zurum Personal — emotionally nuanced / complex moments (premium)
  | "jobhunt-write"; // Job-hunt agent — drafts one application from a resume + posting

/** Providers the router can talk to. Fallbacks are Gemini + DeepSeek (not GPT). */
export type ProviderName =
  | "anthropic"
  | "kimi"
  | "gemini"
  | "deepseek"
  | "openai";

/** Reasoning effort — GA across current Claude models; other providers ignore it. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A concrete (provider, model) target with optional tuning. */
export interface ModelSpec {
  provider: ProviderName;
  model: string;
  effort?: Effort;
}

/** A single conversational turn passed to a provider. */
export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

/** Provider-agnostic completion request. */
export interface CompletionRequest {
  /** System prompt. Stable prefixes are cached where the provider supports it. */
  system?: string;
  messages: ModelMessage[];
  /** Hard output ceiling. Router streams when this is large to avoid timeouts. */
  maxTokens?: number;
  /** Overrides the routing table's effort for this call. */
  effort?: Effort;
  /**
   * Set false to disable extended/adaptive thinking for this call. Useful for
   * pure generation (e.g. Forge emitting HTML) where thinking tokens add cost
   * without improving the output. Defaults to on where the model supports it.
   */
  thinking?: boolean;
  /** Opaque id used for logging + cost attribution (job/agent/model tagging). */
  jobId?: string;
  /** Abort signal for runaway-sentinel enforcement (§8). */
  signal?: AbortSignal;
}

/** Token accounting for one provider call — feeds cost instrumentation (§10). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Normalised completion result returned to the caller. */
export interface CompletionResult {
  text: string;
  spec: ModelSpec;
  usage: Usage;
  /** Approximate USD cost of this call, from the provider's price table. */
  costUsd: number;
  /** How many providers were tried before this one succeeded (0 = primary). */
  fallbackDepth: number;
}

/** Contract every provider adapter implements. */
export interface Provider {
  readonly name: ProviderName;
  /** True when the provider has credentials and can be called. */
  isAvailable(): boolean;
  complete(spec: ModelSpec, req: CompletionRequest): Promise<CompletionResult>;
}

/** Error thrown when every model in a role's ladder has failed. */
export class AllModelsFailedError extends Error {
  constructor(
    public readonly role: AgentRole,
    public readonly attempts: { spec: ModelSpec; error: string }[],
  ) {
    const summary = attempts
      .map((a) => `${a.spec.provider}:${a.spec.model} → ${a.error}`)
      .join(" | ");
    super(`All models failed for role "${role}": ${summary}`);
    this.name = "AllModelsFailedError";
  }
}

/** Marks an error as a transient failure worth retrying before failing over. */
export class TransientProviderError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TransientProviderError";
  }
}

/**
 * A provider is unusable for a while — out of credit, bad/missing key, or no
 * permission (401/403/credit 400). The router puts it on a cooldown and skips
 * it on subsequent calls instead of wasting a round-trip every message. Auto-
 * recovers after the cooldown (e.g. once the account is topped up).
 */
export class ProviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAuthError";
  }
}
