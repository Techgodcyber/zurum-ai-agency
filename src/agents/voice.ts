import { callModel } from "../models/index.js";
import { BRAND } from "../config/brand.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "voice" });

/**
 * Natural-voice layer. Rephrases a system DRAFT so it sounds warm and human —
 * in the SAME language/dialect the customer is using. Runs on Haiku and falls
 * back to the plain draft on any failure so the flow never breaks.
 *
 * TWO HARD GUARDS against the "meta leak" (the model replying ABOUT the task —
 * e.g. "I need the customer's last message…" — instead of rewriting the draft):
 *   1. A button id / system token (e.g. "request_change", "topup_5") is NEVER
 *      passed as the language sample — on a button tap msg.text is an id, not
 *      real language, and handing it to the model is what caused the leak.
 *   2. If the model's output looks like meta/clarification, it's DISCARDED and
 *      the clean draft is sent instead — so a misbehaving model can never leak.
 */
export async function phrase(intent: string, customerText: string): Promise<string> {
  const sample = languageSample(customerText);
  try {
    const res = await callModel("aria", {
      system:
        `You are ${BRAND.name}, a warm, friendly website-building assistant. You are given a ` +
        `DRAFT reply to send to a customer. Your ONLY job is to rewrite that draft as ONE short, ` +
        `natural chat message (a fitting emoji is nice), keeping its meaning and any prices, ` +
        `numbers or names exactly.` +
        (sample
          ? ` Write it in the SAME language and dialect as the customer (Nigerian Pidgin, Yoruba, ` +
            `Swahili, French, English, …).`
          : ` Write it in clear, friendly English.`) +
        ` HARD RULES — never break these: do NOT ask a question about the draft; do NOT request ` +
        `clarification; do NOT mention "draft", "placeholder", "language", "dialect" or "the ` +
        `customer's message"; do NOT add notes, labels or explanations; do NOT invent any fact, ` +
        `name, price or promise that isn't in the draft. If you are ever unsure, output the draft ` +
        `unchanged. Output ONLY the finished customer message — nothing before or after it.`,
      messages: [
        {
          role: "user",
          content: sample
            ? `The customer just said: "${sample}"\n\nDRAFT to rewrite and send:\n${intent}`
            : `DRAFT to rewrite and send:\n${intent}`,
        },
      ],
      maxTokens: 200,
      thinking: false,
      jobId: "voice",
    });
    const out = res.text.trim();
    if (!out || looksMeta(out)) {
      if (out) log.warn({ out: out.slice(0, 120) }, "voice.phrase produced meta output — using draft");
      return intent;
    }
    return out;
  } catch (err) {
    log.warn({ err }, "voice.phrase failed — using plain text");
    return intent;
  }
}

/**
 * A usable language sample, or "" when the text can't carry a language signal —
 * a tapped-button id / system token (snake_case, colon- or hyphen-joined, no
 * spaces) or anything too short. Prevents an id like "request_change" from being
 * presented to the model as "the customer's message".
 */
export function languageSample(text: string): string {
  const t = (text ?? "").trim();
  if (t.length < 3) return "";
  if (!/\s/.test(t) && /^[a-z0-9]+([_:-][a-z0-9]+)+$/i.test(t)) return ""; // request_change, topup_5, cur_NGN_5
  return t.slice(0, 400);
}

/** True when the model answered ABOUT the task instead of producing a reply. */
export function looksMeta(out: string): boolean {
  return /(customer'?s (last |actual )?message|last message to match|\bplaceholder\b|could you (please )?provide|please provide the (customer|actual)|i (need|require) the (customer|actual)|match (this|their) (language|dialect)|language\/dialect|\bas an ai\b|the reference "|i'?m (unable|not able) to|i can'?t rewrite|no draft (was )?provided)/i.test(
    out,
  );
}
