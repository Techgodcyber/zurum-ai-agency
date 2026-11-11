import { callModel } from "../models/index.js";
import { BRAND } from "../config/brand.js";
import { PERSONA_POLICY } from "../config/persona.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "aria" });

/**
 * Aria — the post-preview support agent. Once a customer has a preview/live site,
 * every message runs through Aria, which decides in ONE call what they want and
 * replies naturally in their language:
 *   - edit:    they want to change the site  → we run an edit
 *   - approve: they want to publish it live  → we publish
 *   - chat:    greeting / question / "I'm satisfied" / "stop" → just reply
 *
 * This replaces brittle keyword matching (which mistook "hello" for an edit) and
 * handles any language, one round-trip.
 */
export interface AriaResult {
  action: "edit" | "new" | "approve" | "chat" | "link";
  /** For "edit": the change. For "new": the new site description. */
  change?: string;
  /** The message to send the customer right now, in their language. */
  reply: string;
}

const SYSTEM = `${PERSONA_POLICY}

You are ${BRAND.name}, a warm assistant chatting with a customer who ALREADY
has a website preview. Decide based on their MOST RECENT message (earlier messages are
only background — do not act on an old request they didn't just repeat). Choose ONE action:
- "edit": they want to change, improve, restyle, redesign, or fix ANYTHING about
  their CURRENT site. This is the DEFAULT for almost anything about their site —
  INCLUDING big changes like "I don't like it, make it modern", "use real/different
  images", "change the colours", "redo the whole layout", "make it more luxury /
  professional / clean". An edit keeps the SAME site and the SAME URL. When you are
  unsure whether it's an edit or a new site, ALWAYS choose EDIT.
- "new": ONLY when the customer clearly wants a SEPARATE, ADDITIONAL website for a
  DIFFERENT business or purpose (e.g. "now build a site for my OTHER shop", "I also
  need a separate site for my church"), or explicitly says to scrap this and start
  over from scratch. Do NOT choose "new" just because they want big or drastic
  changes — improving or redesigning the current site is an EDIT, not a new site.
- "approve": they want to publish it / make it live / say it's good to go.
- "link": they're asking for the link/URL to their site ("send me the link", "where is my
  website", "give me the url", "share the site").
- "chat": ANYTHING else — greetings ("hello", "hey"), small talk, questions ("how are you",
  "what are you doing"), thanks, or saying they're satisfied / to stop. Chat starts NO build.

Respond in EXACTLY this format (no extra lines):
ACTION: edit | new | approve | link | chat
CHANGE: <one concise line: the change (edit) or the new site description (new)>   (omit for approve/chat)
REPLY: <a short, warm message to send the customer now, in THEIR language/dialect>

Guidance for REPLY:
- edit → say you're on it, applying the change now.
- new → say you're building the new site now.
- approve → say you're publishing it live now.
- link → say here is your site link (the actual URL is attached separately by the system).
- chat → answer or greet naturally; if they're satisfied or say stop, acknowledge warmly and
  say they can ask for changes any time. Do NOT imply you're building anything.
Never output the words ACTION/CHANGE/REPLY inside the REPLY text itself.`;

/**
 * Keyword fallback for when the model doesn't emit a parseable ACTION line
 * (fast models are inconsistent at structured output). Errs toward taking the
 * customer's request seriously rather than silently treating it as chat.
 */
export function inferAction(msg: string): AriaResult["action"] {
  const m = msg.toLowerCase();
  if (/\b(link|url|address)\b|\b(send|share|give|show|where).*(site|website|link|url|page)\b/.test(m))
    return "link";
  if (/\b(approve|publish|go ?live|make it live|looks good|ship it|good to go|it'?s (good|perfect|fine))\b/.test(m))
    return "approve";
  // "new" = an explicit request to build a fresh/separate site — a specific site
  // type, another/different site, or starting over.
  if (
    /\b(build|create|design|generate|make me|i want|i need)\b.*\b(site|website|web ?page|front ?end|landing|app|store|shop|portfolio|blog|page)\b/.test(m) ||
    /\b(different|another|separate|second|new)\b.*\b(site|website|one|design|page)\b/.test(m) ||
    /\b(start (over|again|afresh)|from scratch|scrap (this|it))\b/.test(m)
  )
    return "new";
  // Any change / improvement / restyle / redesign of the CURRENT site → edit
  // (keeps the same site + URL). Broadened so restyle requests aren't mistaken
  // for a new build.
  if (
    /\b(change|make it|add|remove|delete|update|edit|turn|swap|replace|redesign|re-?do|improve|bigger|smaller|colou?r|font|background|image|photo|logo|move|put|use|more|less|modern|professional|clean|better|luxur|don'?t like|do not like|hate|fix|adjust)\b/.test(m)
  )
    return "edit";
  return "chat";
}

/**
 * Decide intent from the customer's LATEST message and reply in their language.
 * `siteContext` is a short factual summary of the site we actually built (title +
 * sections) so questions like "tell me about the site" are answered truthfully
 * instead of invented.
 */
export async function runAria(
  userMessage: string,
  siteContext?: string | null,
  walletFacts?: string | null,
): Promise<AriaResult> {
  const context = siteContext
    ? `\n\nFACTS about the customer's CURRENT site (use these when they ask about it; ` +
      `NEVER claim they have no site — they DO have this one):\n${siteContext}`
    : "\n\nThe customer has no site built yet — say so rather than inventing one.";
  const wallet = walletFacts
    ? `\n\nWALLET FACTS — the REAL, current truth. Answer ANY question about the customer's ` +
      `credits, balance, how many websites they can build, edit costs, or pricing DIRECTLY ` +
      `from these. Do NOT invent plans, a billing team, or a dashboard, and do NOT say you ` +
      `lack access — these numbers ARE the system:\n${walletFacts}`
    : "";
  const res = await callModel("aria", {
    system: SYSTEM + context + wallet,
    // Single latest message only — passing history made the fast model mimic
    // chat style and drop the ACTION format (everything became "chat").
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 300,
    thinking: false,
    jobId: "aria",
  });

  const text = res.text.trim();
  const actionMatch = text.match(/ACTION:\s*(edit|new|approve|link|chat)/i);
  const changeMatch = text.match(/CHANGE:\s*(.+)/i);
  const replyMatch = text.match(/REPLY:\s*([\s\S]+)/i);

  // Trust the model's ACTION if it gave one; otherwise fall back to keywords so
  // a real "build me X" request is never silently swallowed as chat.
  const action = (actionMatch?.[1]?.toLowerCase() as AriaResult["action"]) ?? inferAction(userMessage);
  const change = changeMatch?.[1]?.trim() ?? userMessage;
  const reply =
    (replyMatch?.[1] ?? text.replace(/ACTION:.*/i, "").replace(/CHANGE:.*/i, ""))
      .trim() || "Got it! 😊";

  log.info({ action, viaModel: Boolean(actionMatch) }, "aria decision");
  const needsChange = action === "edit" || action === "new";
  return { action, change: needsChange ? change : undefined, reply };
}
