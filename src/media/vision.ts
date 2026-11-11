import { env } from "../config/env.js";
import { geminiGenerate, isGeminiConfigured } from "./gemini.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "vision" });

/** True when SOME vision backend is available (Claude, or Gemini). */
export function canSeeImages(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY) || isGeminiConfigured();
}

/** Claude (Anthropic) multimodal call. Returns the text, or null. */
async function claudeVision(base64: string, mime: string, prompt: string, signal?: AbortSignal): Promise<string | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: env.VISION_MODEL,
      max_tokens: 1100,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: base64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
    signal: signal ?? AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`claude vision ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const j = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  return text || null;
}

async function geminiVision(base64: string, mime: string, prompt: string, signal?: AbortSignal): Promise<string | null> {
  if (!isGeminiConfigured()) return null;
  const t = await geminiGenerate(
    [{ inline_data: { mime_type: mime, data: base64 } }, { text: prompt }],
    env.GEMINI_VISION_MODEL,
    signal,
  );
  return t.trim() || null;
}

/**
 * Read an image with whichever vision provider is preferred (VISION_PROVIDER),
 * falling back to the other. Throws only if BOTH are unavailable/fail. This lets
 * the founder flip to cheap Gemini with one env change once its billing works.
 */
async function see(base64: string, mime: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const order: ("claude" | "gemini")[] =
    env.VISION_PROVIDER === "gemini" ? ["gemini", "claude"] : ["claude", "gemini"];
  for (const provider of order) {
    try {
      const t =
        provider === "gemini"
          ? await geminiVision(base64, mime, prompt, signal)
          : await claudeVision(base64, mime, prompt, signal);
      if (t) return t;
    } catch (err) {
      log.warn({ provider, err: (err as Error).message }, "vision provider failed — trying the other");
    }
  }
  throw new Error("no vision backend available");
}

const BUILD_PROMPT =
  "This image is a screenshot or photo of a website/web-page design the customer wants recreated. " +
  "Write a precise BUILD BRIEF a developer can rebuild from: overall layout, each section top-to-bottom, " +
  "colour palette (hex if you can tell), fonts/typography style, key components (nav, hero, cards, forms, " +
  "buttons, footer), and any visible text/labels. Be concrete and structured. Output only the brief.";

/** Turn a screenshot of a design into a precise build brief for Forge. */
export async function describeImageForBuild(base64: string, mime: string, signal?: AbortSignal): Promise<string> {
  const brief = await see(base64, mime, BUILD_PROMPT, signal);
  log.info({ chars: brief.length }, "image described for build");
  return brief;
}

/**
 * Interpret an annotated screenshot of the customer's OWN site + their words
 * into a precise EDIT instruction Forge can apply. Handles "fix the circled bit"
 * style requests (the exact thing that used to get misfiled as a logo).
 */
export async function describeImageForEdit(
  base64: string,
  mime: string,
  instruction: string,
  signal?: AbortSignal,
): Promise<string> {
  const prompt =
    `This is a screenshot of the customer's OWN website. They wrote: "${instruction}". They may have ` +
    `circled, arrowed or marked the exact spot they mean. Looking at the image, describe the SPECIFIC ` +
    `change to make — which element/section, and exactly what to do — as one clear instruction a ` +
    `developer can apply (e.g. "Remove the screenshot image being used as the logo in the header and ` +
    `use the brand name text instead", or "Change the circled 'Buy' button from grey to green"). Do NOT ` +
    `rebuild the whole site. Output ONLY the edit instruction.`;
  const edit = await see(base64, mime, prompt, signal);
  log.info({ chars: edit.length }, "image described for edit");
  return edit;
}
