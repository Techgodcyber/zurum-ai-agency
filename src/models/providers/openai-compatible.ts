import { priceOf } from "../routing.js";
import {
  ProviderAuthError,
  TransientProviderError,
  type CompletionRequest,
  type CompletionResult,
  type ModelSpec,
  type Provider,
  type ProviderName,
} from "../types.js";

/**
 * Generic provider for any OpenAI-compatible /chat/completions endpoint.
 *
 * Kimi (Moonshot), DeepSeek, OpenAI and Gemini all expose this same shape, so a
 * single adapter serves all four — differing only by base URL, key and model id.
 * Anthropic keeps its own native adapter (thinking/effort/caching support).
 */
export class OpenAICompatibleProvider implements Provider {
  readonly name: ProviderName;
  #apiKey: string | null;
  #baseUrl: string;

  constructor(name: ProviderName, baseUrl: string, apiKey: string | null) {
    this.name = name;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#apiKey = apiKey;
  }

  isAvailable(): boolean {
    return this.#apiKey !== null;
  }

  async complete(
    spec: ModelSpec,
    req: CompletionRequest,
  ): Promise<CompletionResult> {
    if (!this.#apiKey) throw new Error(`${this.name} called without an API key`);

    const messages: { role: string; content: string }[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content });

    // Per-request timeout so a slow/hung connection fails FAST and fails over to
    // the next provider, instead of leaving a build stuck for minutes. Combined
    // with the job's own abort signal (wall-clock cap).
    const timeout = AbortSignal.timeout(90_000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: spec.model,
          messages,
          max_tokens: req.maxTokens ?? 8_192,
        }),
        signal,
      });
    } catch (err) {
      const reason = timeout.aborted ? "timed out after 90s" : err instanceof Error ? err.message : String(err);
      throw new TransientProviderError(`${this.name} connection: ${reason}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 429 || res.status >= 500) {
        throw new TransientProviderError(`${this.name} ${res.status}: ${body}`);
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderAuthError(`${this.name} ${res.status}: ${body}`);
      }
      // Out-of-credit shows up as 402 on some providers.
      if (res.status === 402) {
        throw new ProviderAuthError(`${this.name} 402 (billing): ${body}`);
      }
      throw new Error(`${this.name} ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;

    return {
      text: data.choices?.[0]?.message?.content ?? "",
      spec,
      usage: { inputTokens, outputTokens },
      costUsd: priceOf(spec, inputTokens, outputTokens),
      fallbackDepth: 0,
    };
  }
}
