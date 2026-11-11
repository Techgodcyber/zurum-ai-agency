import { env } from "../../config/env.js";
import type { Provider, ProviderName } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/**
 * Provider registry. Anthropic uses its native adapter (thinking/effort/caching);
 * Kimi, DeepSeek, OpenAI and Gemini all share the OpenAI-compatible adapter.
 * A provider without a key simply reports unavailable and the router skips it.
 */
const registry: Record<ProviderName, Provider> = {
  anthropic: new AnthropicProvider(),
  kimi: new OpenAICompatibleProvider("kimi", env.KIMI_BASE_URL, env.KIMI_API_KEY ?? null),
  deepseek: new OpenAICompatibleProvider(
    "deepseek",
    env.DEEPSEEK_BASE_URL,
    env.DEEPSEEK_API_KEY ?? null,
  ),
  openai: new OpenAICompatibleProvider(
    "openai",
    env.OPENAI_BASE_URL,
    env.OPENAI_API_KEY ?? null,
  ),
  gemini: new OpenAICompatibleProvider(
    "gemini",
    env.GEMINI_BASE_URL,
    env.GEMINI_API_KEY ?? null,
  ),
};

export function getProvider(name: ProviderName): Provider {
  return registry[name];
}

/** Names of providers that are actually configured (have a key). */
export function availableProviders(): ProviderName[] {
  return (Object.keys(registry) as ProviderName[]).filter((n) =>
    registry[n].isAvailable(),
  );
}
