import { logger } from "../lib/logger.js";
import { getProvider } from "./providers/index.js";
import { ladderFor } from "./routing.js";
import {
  AllModelsFailedError,
  ProviderAuthError,
  TransientProviderError,
  type AgentRole,
  type CompletionRequest,
  type CompletionResult,
  type ModelSpec,
  type ProviderName,
} from "./types.js";

const log = logger.child({ mod: "model-router" });

/** Retry/backoff policy for transient (429 / 5xx / network) failures. */
const MAX_RETRIES = 2; // per model, before failing over
const BASE_BACKOFF_MS = 500;

/**
 * Circuit breaker. When a provider reports it's out of credit / unauthorised,
 * we skip it for this cooldown instead of wasting a round-trip on every call.
 * Auto-recovers when the cooldown lapses (e.g. after a top-up).
 */
const AUTH_COOLDOWN_MS = 5 * 60_000;
const cooldownUntil = new Map<ProviderName, number>();

function isCoolingDown(provider: ProviderName): boolean {
  const until = cooldownUntil.get(provider);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    cooldownUntil.delete(provider);
    return false;
  }
  return true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });
}

/**
 * Call the model for an agent role, walking the failover ladder (§8):
 *
 *   1. transient error → retry the SAME model up to MAX_RETRIES (backoff)
 *   2. still failing / unavailable → fail over to the next model in the ladder
 *   3. ladder exhausted → throw AllModelsFailedError (caller queues + retries)
 *
 * Unavailable providers (no key, or not yet implemented) are skipped silently.
 * Success returns the winning model + usage + approximate cost, with
 * `fallbackDepth` recording how far down the ladder we landed (0 = primary).
 */
export async function callModel(
  role: AgentRole,
  req: CompletionRequest,
): Promise<CompletionResult> {
  const ladder = ladderFor(role);
  const attempts: { spec: ModelSpec; error: string }[] = [];

  // Providers reject empty-content messages. A stray empty turn (e.g. a prior
  // failed reply that got stored in history) would otherwise 400 every model —
  // replace any empty content with a placeholder so calls never crash on it.
  const safeReq: CompletionRequest = {
    ...req,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: m.content && m.content.trim() ? m.content : "…",
    })),
  };

  for (let depth = 0; depth < ladder.length; depth++) {
    const spec = ladder[depth]!;
    const provider = getProvider(spec.provider);

    if (!provider.isAvailable()) {
      log.debug({ role, spec, depth }, "skipping unavailable provider");
      attempts.push({ spec, error: "provider unavailable" });
      continue;
    }

    if (isCoolingDown(spec.provider)) {
      log.debug({ role, spec, depth }, "skipping provider (auth cooldown)");
      attempts.push({ spec, error: "provider cooling down (auth/credit)" });
      continue;
    }

    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      if (req.signal?.aborted) throw new Error("model call aborted");
      try {
        const result = await provider.complete(spec, safeReq);
        result.fallbackDepth = depth;
        log.info(
          {
            role,
            provider: spec.provider,
            model: spec.model,
            depth,
            retry,
            jobId: req.jobId,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cacheReadTokens: result.usage.cacheReadTokens,
            costUsd: Number(result.costUsd.toFixed(6)),
          },
          "model call ok",
        );
        return result;
      } catch (err) {
        const transient = err instanceof TransientProviderError;
        const message = err instanceof Error ? err.message : String(err);

        // Out of credit / unauthorised → cool the provider down and move on.
        if (err instanceof ProviderAuthError) {
          cooldownUntil.set(spec.provider, Date.now() + AUTH_COOLDOWN_MS);
          log.warn(
            { role, provider: spec.provider, cooldownMs: AUTH_COOLDOWN_MS },
            "provider auth/credit error — cooling down",
          );
          attempts.push({ spec, error: message });
          break;
        }

        if (transient && retry < MAX_RETRIES) {
          const backoff =
            err.retryAfterMs ??
            BASE_BACKOFF_MS * 2 ** retry + Math.floor(Math.random() * 200);
          log.warn(
            { role, spec, retry, backoff, error: message },
            "transient error, retrying",
          );
          await sleep(backoff, req.signal);
          continue;
        }

        // Permanent, or retries exhausted → fail over to the next model.
        log.warn({ role, spec, depth, error: message }, "model failed, failing over");
        attempts.push({ spec, error: message });
        break;
      }
    }
  }

  throw new AllModelsFailedError(role, attempts);
}
