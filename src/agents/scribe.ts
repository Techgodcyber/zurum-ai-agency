import { callModel, type ModelMessage } from "../models/index.js";
import { BRAND } from "../config/brand.js";
import { PERSONA_POLICY } from "../config/persona.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "scribe" });

/**
 * Scribe — the intake agent (first live agent). Runs a short, friendly
 * clarifying chat with the customer, then produces a concrete build spec Maestro
 * can hand to Forge.
 *
 * Protocol: Scribe replies with EITHER a single clarifying question, OR — once it
 * has enough — a line beginning `SPEC:` followed by the build spec. We keep the
 * protocol text-based (no structured-output dependency) so it works on Haiku.
 */
const SYSTEM = `${PERSONA_POLICY}

You are ${BRAND.name} — a warm, friendly assistant that builds websites
for people over chat. Talk like a helpful human, not a robot: natural, relaxed,
encouraging. Keep messages short and easy.

LANGUAGE: Always reply in the SAME language and dialect the customer uses — including
Nigerian Pidgin, Yoruba, Swahili, French, Arabic, and others. Match their vibe and warmth.

Your goal: gather just enough to build their website, then hand off.
- If this is their first message, greet them warmly as ${BRAND.name} in one short line,
  then continue naturally.
- Gather: (1) what the site is for / the business, (2) key pages or sections,
  (3) any style or colour vibe. Don't over-ask — 1 to 2 questions is usually enough.
- The moment you have enough, STOP asking and output the spec.

Output rules (strict):
- Still need info → reply with ONE short, friendly message (a single question), written
  in the CUSTOMER'S language/dialect.
- Enough info → reply with EXACTLY one line starting "SPEC:" then a concise build spec
  (site type, key sections, style). Keep the SPEC text itself in ENGLISH (it's for our
  builder), even if you chatted in another language. Nothing else on that line.
- Never invent details the customer didn't give.`;

export interface ScribeResult {
  /** True once a build spec has been produced. */
  done: boolean;
  /** Message to send back to the customer (the question, or a friendly handoff). */
  reply: string;
  /** The build spec, present only when done. */
  spec?: string;
}

/**
 * Advance the intake conversation. `history` is the full turn history INCLUDING
 * the latest customer message as the final `user` turn.
 */
export async function runScribe(history: ModelMessage[]): Promise<ScribeResult> {
  const res = await callModel("scribe", {
    system: SYSTEM,
    messages: history,
    maxTokens: 400,
    jobId: "scribe-intake",
  });

  const text = res.text.trim();
  const specMatch = text.match(/SPEC:\s*([\s\S]+)/i);

  if (specMatch) {
    const spec = specMatch[1]!.trim();
    log.info({ spec }, "intake complete");
    return {
      done: true,
      spec,
      reply: `Perfect — I've got what I need. Building your preview now, I'll send you the link shortly. 🛠️`,
    };
  }

  return {
    done: false,
    reply: text || "Tell me a bit about the website you'd like and I'll build it for you 😊",
  };
}
