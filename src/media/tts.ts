import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "tts" });

/**
 * Text-to-speech for Zurum Personal voice notes. OpenAI-compatible /audio/speech
 * by default (tts-1); point VOICE_TTS_BASE_URL + VOICE_TTS_KEY at ElevenLabs or
 * another provider for a premium voice. Provider choice sets the voice-credit
 * price (PERSONAL_ARCHITECTURE.md §6/§7). Never throws — returns null on failure
 * so the caller falls back to a text reply.
 */

function ttsKey(): string | undefined {
  return env.VOICE_TTS_KEY ?? env.OPENAI_API_KEY;
}
function ttsBase(): string {
  return env.VOICE_TTS_BASE_URL ?? env.OPENAI_BASE_URL;
}

/** True when a TTS backend is configured. */
export function canSynthesize(): boolean {
  if (env.VOICE_PROVIDER === "elevenlabs") return Boolean(env.ELEVENLABS_API_KEY);
  if (env.VOICE_PROVIDER === "hume") return Boolean(env.HUME_API_KEY);
  return Boolean(ttsKey());
}

export interface Speech {
  audio: Buffer;
  mime: string;
}

/**
 * Synthesize speech from text. `voice` overrides the default (a companion's
 * gendered voice — an OpenAI voice name or an ElevenLabs voice id). Returns audio
 * bytes (OGG/Opus, Telegram-friendly). Routes to the configured provider.
 */
export async function synthesizeSpeech(text: string, voice?: string, signal?: AbortSignal): Promise<Speech | null> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 4000); // bound the cost per reply
  if (!clean) return null;
  if (env.VOICE_PROVIDER === "elevenlabs") return elevenlabs(clean, voice, signal);
  if (env.VOICE_PROVIDER === "hume") return hume(clean, voice, signal);
  return openaiTts(clean, voice, signal);
}

/**
 * Hume Octave — emotionally expressive TTS. `voice` is either a saved Hume voice
 * name (no spaces) or a natural-language description (has spaces) that steers the
 * voice + emotion. Outputs mp3 (audio/mpeg) — Telegram plays it as an audio clip.
 */
async function hume(text: string, voice: string | undefined, signal?: AbortSignal): Promise<Speech | null> {
  const key = env.HUME_API_KEY;
  if (!key) return null;
  const utterance: Record<string, unknown> = { text };
  if (voice) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(voice)) {
      utterance.voice = { id: voice, provider: "CUSTOM_VOICE" }; // a cloned/custom Hume voice
    } else if (voice.includes(" ")) {
      utterance.description = voice; // natural-language voice/emotion
    } else {
      utterance.voice = { name: voice }; // a named Hume library voice
    }
  }
  try {
    const res = await fetch("https://api.hume.ai/v0/tts/file", {
      method: "POST",
      headers: { "X-Hume-Api-Key": key, "content-type": "application/json" },
      body: JSON.stringify({ utterances: [utterance], format: { type: "mp3" } }),
      signal: signal ?? AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      log.warn({ status: res.status, body: (await res.text().catch(() => "")).slice(0, 200) }, "hume tts failed");
      return null;
    }
    const audio = Buffer.from(await res.arrayBuffer());
    return audio.length ? { audio, mime: "audio/mpeg" } : null;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "hume tts error");
    return null;
  }
}

/** ElevenLabs — genuinely human/emotional voices (companion bonding). */
async function elevenlabs(text: string, voice: string | undefined, signal?: AbortSignal): Promise<Speech | null> {
  const key = env.ELEVENLABS_API_KEY;
  if (!key) return null;
  const voiceId = voice || env.ELEVENLABS_VOICE_FEMALE;
  try {
    // opus_48000 → Ogg/Opus, which Telegram plays as a real voice note.
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=opus_48000_128`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/ogg" },
        body: JSON.stringify({
          text,
          model_id: env.ELEVENLABS_MODEL,
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
        }),
        signal: signal ?? AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      log.warn({ status: res.status, body: (await res.text().catch(() => "")).slice(0, 200) }, "elevenlabs tts failed");
      return null;
    }
    const audio = Buffer.from(await res.arrayBuffer());
    return audio.length ? { audio, mime: "audio/ogg" } : null;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "elevenlabs tts error");
    return null;
  }
}

/** OpenAI-compatible /audio/speech (default provider). */
async function openaiTts(text: string, voice?: string, signal?: AbortSignal): Promise<Speech | null> {
  const key = ttsKey();
  if (!key) return null;
  const clean = text;
  try {
    const res = await fetch(`${ttsBase()}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: env.VOICE_TTS_MODEL,
        voice: voice || env.VOICE_TTS_VOICE,
        input: clean,
        response_format: "opus", // Telegram voice notes are OGG/Opus
      }),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "tts request failed");
      return null;
    }
    const audio = Buffer.from(await res.arrayBuffer());
    return audio.length ? { audio, mime: "audio/ogg" } : null;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "tts failed");
    return null;
  }
}
