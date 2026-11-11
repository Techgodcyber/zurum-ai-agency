import type { IncomingMessage, ServerResponse } from "node:http";
import { saveSubmission } from "./store.js";
import * as conv from "../conversations/store.js";
import { logger } from "../lib/logger.js";
import type { ChannelName, OutboundSender } from "../channels/types.js";

const log = logger.child({ mod: "forms" });

/** Cap the body so a bad actor can't post megabytes at us. */
const MAX_BODY = 32 * 1024;
const MAX_FIELDS = 25;
const MAX_VALUE = 2000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Parse urlencoded or JSON form bodies into a clean, bounded field map. */
export function parseFields(body: string, contentType: string): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (k: string, v: unknown) => {
    const key = k.trim().slice(0, 64);
    if (!key || Object.keys(out).length >= MAX_FIELDS) return;
    out[key] = String(v ?? "").slice(0, MAX_VALUE);
  };
  if (contentType.includes("application/json")) {
    try {
      const j = JSON.parse(body) as Record<string, unknown>;
      for (const [k, v] of Object.entries(j)) add(k, v);
    } catch {
      /* ignore malformed json */
    }
  } else {
    for (const [k, v] of new URLSearchParams(body)) add(k, v);
  }
  return out;
}

/** The page a visitor sees after submitting (kept friendly + on-brand). */
function thanksPage(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank you</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#0f172a}
@media(prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}}
.c{max-width:30rem;padding:2.5rem;text-align:center}
h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:0;opacity:.75}
.t{font-size:3rem;line-height:1;margin-bottom:1rem}
a{display:inline-block;margin-top:1.5rem;color:inherit;opacity:.6;font-size:.9rem}
</style></head><body><div class="c"><div class="t">✅</div>
<h1>Thank you!</h1><p>Your message has been received. We'll get back to you soon.</p>
<a href="javascript:history.back()">← Back to the site</a></div></body></html>`;
}

/**
 * Handle POST /f/:siteId — a submission from a generated site's contact/booking
 * form. Stores it and pings the site owner in chat, so a static site becomes a
 * real lead-capture tool. Always responds friendly; never leaks internals.
 */
export async function handleFormPost(
  siteId: string,
  req: IncomingMessage,
  res: ServerResponse,
  sender?: OutboundSender,
): Promise<void> {
  let fields: Record<string, string> = {};
  try {
    const body = await readBody(req);
    fields = parseFields(body, req.headers["content-type"] ?? "");
  } catch {
    res.writeHead(413, { "content-type": "text/plain" });
    res.end("Submission too large");
    return;
  }

  // Honeypot: bots fill hidden fields. Accept silently so they don't retry.
  const isBot = Boolean(fields["_hp"] || fields["website_url"]);
  const formName = fields["_form"] ?? null;
  delete fields["_hp"];
  delete fields["website_url"];
  delete fields["_form"];

  if (!isBot && Object.keys(fields).length) {
    try {
      const ip =
        (req.headers["cf-connecting-ip"] as string) ??
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
        req.socket.remoteAddress ??
        null;
      await saveSubmission({ siteId, formName, data: fields, ip });
      log.info({ siteId, fields: Object.keys(fields).length }, "form submission");
      void notifyOwner(siteId, fields, sender); // fire-and-forget
    } catch (err) {
      log.error({ err, siteId }, "failed to store form submission");
    }
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(thanksPage());
}

/** Tell the site owner, in their chat, that they got a new enquiry. */
async function notifyOwner(
  siteId: string,
  fields: Record<string, string>,
  sender?: OutboundSender,
): Promise<void> {
  if (!sender) return;
  try {
    const c = await conv.bySite(siteId);
    if (!c) return;
    const lines = Object.entries(fields)
      .slice(0, 8)
      .map(([k, v]) => `• ${k}: ${v.slice(0, 200)}`);
    await sender.send(
      c.channel as ChannelName,
      c.chatId,
      `📬 New enquiry from your website!\n\n${lines.join("\n")}`,
    );
  } catch (err) {
    log.warn({ err, siteId }, "owner notification failed");
  }
}
