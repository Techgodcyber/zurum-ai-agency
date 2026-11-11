import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env.js";
import { priceOf } from "../routing.js";
import {
  ProviderAuthError,
  TransientProviderError,
  type CompletionRequest,
  type CompletionResult,
  type ModelSpec,
  type Provider,
} from "../types.js";

/**
 * Anthropic (Claude) provider adapter.
 *
 * Handles the per-model capability differences the API enforces:
 *  - Opus 4.8 / Sonnet 5 / Fable 5: `output_config.effort` + adaptive thinking.
 *    (Opus/Sonnet need `thinking:{type:"adaptive"}` explicitly; Fable is always
 *    on, so we omit the param — sending config there is a 400.)
 *  - Haiku 4.5: NO effort, NO adaptive thinking (both error) — plain call.
 *
 * Prompt caching (§10 cost lever): the system prompt is sent as a cached block,
 * so repeated agent/system prefixes bill at ~0.1x on subsequent calls.
 */

type ThinkingMode = "adaptive-optin" | "always-on" | "none";

function supportsEffort(model: string): boolean {
  return !model.includes("haiku");
}

function thinkingMode(model: string): ThinkingMode {
  if (model.includes("haiku")) return "none";
  if (model.includes("fable") || model.includes("mythos")) return "always-on";
  return "adaptive-optin";
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;
  #client: Anthropic | null;

  constructor() {
    this.#client = env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
      : null;
  }

  isAvailable(): boolean {
    return this.#client !== null;
  }

  async complete(
    spec: ModelSpec,
    req: CompletionRequest,
  ): Promise<CompletionResult> {
    if (!this.#client) {
      throw new Error("Anthropic provider called without ANTHROPIC_API_KEY");
    }

    const maxTokens = req.maxTokens ?? 8_192;
    const effort = req.effort ?? spec.effort;
    const mode = thinkingMode(spec.model);

    // Base params (typed). Extra capability fields are merged loosely below,
    // since `output_config`/`thinking` shapes vary by SDK version.
    const base: Anthropic.Messages.MessageCreateParams = {
      model: spec.model,
      max_tokens: maxTokens,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (req.system) {
      // Cached system block — stable prefix bills at cache-read rates on reuse.
      (base as Anthropic.Messages.MessageCreateParams).system = [
        { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
      ];
    }

    const thinkingWanted = req.thinking !== false;
    const extra: Record<string, unknown> = {};
    // Opus/Sonnet opt in to adaptive thinking; skip it when the caller disabled
    // thinking (e.g. Forge generation) to avoid paying for thinking tokens.
    if (mode === "adaptive-optin" && thinkingWanted) {
      extra["thinking"] = { type: "adaptive" };
    }
    if (effort && supportsEffort(spec.model)) {
      extra["output_config"] = { effort };
    }

    const params = { ...base, ...extra } as Anthropic.Messages.MessageCreateParams;

    try {
      // Stream for large outputs to dodge SDK HTTP timeouts (skill guidance).
      const message =
        maxTokens > 16_000
          ? await this.#client.messages
              .stream(params as Anthropic.Messages.MessageCreateParamsStreaming, {
                signal: req.signal,
              })
              .finalMessage()
          : await this.#client.messages.create(
              params as Anthropic.Messages.MessageCreateParamsNonStreaming,
              { signal: req.signal },
            );

      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const u = message.usage;
      const inputTokens = u.input_tokens ?? 0;
      const outputTokens = u.output_tokens ?? 0;
      const cacheReadTokens = u.cache_read_input_tokens ?? 0;
      const cacheWriteTokens = u.cache_creation_input_tokens ?? 0;

      return {
        text,
        spec,
        usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
        // Cached reads are ~0.1x input; approximate that in the cost estimate.
        costUsd: priceOf(
          spec,
          inputTokens + Math.round(cacheReadTokens * 0.1),
          outputTokens,
        ),
        fallbackDepth: 0, // set by the router
      };
    } catch (err) {
      throw normaliseAnthropicError(err);
    }
  }
}

/** Map SDK errors to transient (retryable) vs permanent for the router ladder. */
function normaliseAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    // 429 + 5xx + overloaded are worth retrying before failing over.
    if (status === 429 || status >= 500) {
      const retryAfter = Number(err.headers?.["retry-after"]) * 1000;
      return new TransientProviderError(
        `anthropic ${status}: ${err.message}`,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      );
    }
    // Out of credit / bad key / no permission → cool the provider down so we
    // stop wasting a round-trip on it every message.
    const credit = /credit balance/i.test(err.message);
    if (status === 401 || status === 403 || (status === 400 && credit)) {
      return new ProviderAuthError(`anthropic ${status}: ${err.message}`);
    }
    return new Error(`anthropic ${status}: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new TransientProviderError(`anthropic connection: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
