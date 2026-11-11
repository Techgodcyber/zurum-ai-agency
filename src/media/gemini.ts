import { env } from "../config/env.js";

/**
 * Thin wrapper over Gemini's NATIVE generateContent API for MULTIMODAL input
 * (audio, images). Text-only model calls go through the model-router's
 * OpenAI-compatible adapter; this is only for the media features (voice-note
 * transcription and image/vision) where we send inline audio/image parts.
 */

// The router uses the OpenAI-compat base (.../v1beta/openai); native lives at
// .../v1beta.
const NATIVE_BASE = env.GEMINI_BASE_URL.replace(/\/openai\/?$/, "");

export function isGeminiConfigured(): boolean {
  return Boolean(env.GEMINI_API_KEY);
}

export interface InlineData {
  inline_data: { mime_type: string; data: string }; // data = base64 (no prefix)
}
export type Part = { text: string } | InlineData;

/** Call Gemini with a set of parts (text + inline media). Returns the text out. */
export async function geminiGenerate(
  parts: Part[],
  model = "gemini-2.0-flash",
  signal?: AbortSignal,
): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new Error("Gemini not configured");
  const res = await fetch(
    `${NATIVE_BASE}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
      signal,
    },
  );
  if (!res.ok) {
    throw new Error(`gemini ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return (
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim() ?? ""
  );
}

/** Split a data URI into its mime type + raw base64 payload. */
export function splitDataUri(dataUri: string): { mime: string; base64: string } {
  const m = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return { mime: "application/octet-stream", base64: dataUri };
  return { mime: m[1]!, base64: m[2]! };
}
