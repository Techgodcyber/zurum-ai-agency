import { env } from "../config/env.js";
import { geminiGenerate, isGeminiConfigured } from "./gemini.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "transcribe" });

/** True when SOME speech-to-text backend is available (Whisper or Gemini). */
export function canTranscribe(): boolean {
  return Boolean(env.WHISPER_API_KEY) || isGeminiConfigured();
}

/**
 * Transcribe a voice note to text in its ORIGINAL language (Pidgin, English,
 * French, …) so the rest of the pipeline treats it like a typed message.
 *
 * Prefers a Whisper endpoint (Groq's free tier by default), falls back to Gemini
 * audio if that's funded. NEVER throws — returns null on any failure so the
 * caller can reply "please type it" instead of the whole handler dying silently.
 */
export async function transcribeAudio(
  base64: string,
  mime: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (env.WHISPER_API_KEY) {
    try {
      const t = await whisper(base64, mime, signal);
      if (t) {
        log.info({ chars: t.length, via: "whisper" }, "voice transcribed");
        return t;
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, "whisper transcription failed — trying fallback");
    }
  }
  if (isGeminiConfigured()) {
    try {
      const text = await geminiGenerate(
        [
          { inline_data: { mime_type: mime, data: base64 } },
          {
            text:
              "Transcribe this voice message word-for-word in its ORIGINAL language " +
              "(it may be Nigerian Pidgin, English, French, Swahili, Yoruba, etc.). " +
              "Return ONLY the transcription text — no translation, no quotes, no commentary.",
          },
        ],
        "gemini-2.0-flash",
        signal,
      );
      const t = text.trim();
      if (t) {
        log.info({ chars: t.length, via: "gemini" }, "voice transcribed");
        return t;
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, "gemini transcription failed");
    }
  }
  return null;
}

/** OpenAI-compatible Whisper transcription (Groq / OpenAI). */
async function whisper(base64: string, mime: string, signal?: AbortSignal): Promise<string | null> {
  const buf = Buffer.from(base64, "base64");
  const ext = mime.includes("mp3") || mime.includes("mpeg") ? "mp3" : mime.includes("wav") ? "wav" : "ogg";
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mime }), `audio.${ext}`);
  form.append("model", env.WHISPER_MODEL);
  form.append("response_format", "json");
  const res = await fetch(`${env.WHISPER_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.WHISPER_API_KEY}` },
    body: form,
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = (await res.json()) as { text?: string };
  return (j.text ?? "").trim() || null;
}
