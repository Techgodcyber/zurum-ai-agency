import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { transcribeAudio, canTranscribe } from "../media/transcribe.js";
import { WhatsAppCalling, extractCalls, type MetaCall } from "./whatsapp-calling.js";
import type { Action, Channel, InboundHandler, IncomingMessage } from "./types.js";

const log = logger.child({ mod: "whatsapp" });

/**
 * WhatsApp adapter over Meta's WhatsApp Cloud API — direct, no BSP.
 *
 * Same Channel interface as Telegram, so the whole core (Scribe, Maestro,
 * billing, publish) is shared — this file is only the transport.
 *
 *  - SENDING needs WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID (no public URL).
 *  - RECEIVING is webhook-based: Meta GETs the callback URL once to verify
 *    (see verifyWebhook), then POSTs messages. The web server routes both to us.
 *
 * Interactive reply buttons (≤3) / list (≤10) map our Actions natively. If an
 * interactive send fails we fall back to a numbered text menu whose reply maps
 * back to the action id — so button flows never break.
 */
export class WhatsAppChannel implements Channel {
  readonly name = "whatsapp" as const;
  #onMessage: InboundHandler | null = null;
  readonly #token = env.WHATSAPP_TOKEN;
  readonly #phoneId = env.WHATSAPP_PHONE_NUMBER_ID;
  readonly #base = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}`;
  #pending = new Map<string, { actions: Action[]; at: number }>();
  // Calling plumbing (Business Calling API). No live-media handler yet, so inbound
  // calls are declined politely with a nudge to voice notes (see whatsapp-calling.ts).
  readonly #calling = new WhatsAppCalling({
    token: env.WHATSAPP_TOKEN ?? "",
    phoneId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    base: this.#base,
    sendText: (to, text) => this.send(to, text),
  });

  isConfigured(): boolean {
    return Boolean(this.#token && this.#phoneId);
  }

  async start(onMessage: InboundHandler): Promise<void> {
    this.#onMessage = onMessage;
    log.info(
      { phoneId: this.#phoneId, webhook: this.webhookPath() },
      "WhatsApp (Meta Cloud API) ready — set this as the Callback URL in the Meta app",
    );
  }

  /** The inbound webhook path Meta should call (prefix with your public domain). */
  webhookPath(): string {
    return `/webhooks/whatsapp/${env.WHATSAPP_WEBHOOK_TOKEN}/inbound`;
  }

  /** Answer Meta's GET verification handshake. Returns the challenge, or null. */
  verifyWebhook(mode: string | null, token: string | null, challenge: string | null): string | null {
    if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN) return challenge ?? "";
    log.warn({ mode }, "webhook verification rejected (token mismatch)");
    return null;
  }

  // ── Sending ────────────────────────────────────────────

  async send(chatId: string, text: string): Promise<void> {
    await this.#post({ to: chatId, type: "text", text: { body: text, preview_url: true } });
  }

  async sendActions(chatId: string, text: string, actions: Action[]): Promise<void> {
    if (actions.length >= 1 && actions.length <= 10) {
      try {
        await this.#post({ to: chatId, type: "interactive", interactive: interactive(text, actions) });
        return;
      } catch (err) {
        log.warn({ err: (err as Error).message }, "interactive send failed — using numbered menu");
      }
    }
    await this.#numberedMenu(chatId, text, actions);
  }

  /** Fallback: a numbered text menu; the reply number maps back to the action. */
  async #numberedMenu(chatId: string, text: string, actions: Action[]): Promise<void> {
    const lines = actions.map((a, i) => `${i + 1}. ${a.label}`).join("\n");
    await this.send(chatId, `${text}\n\n${lines}\n\nReply with the number.`);
    this.#pending.set(chatId, { actions, at: Date.now() });
  }

  async #post(message: Record<string, unknown>): Promise<void> {
    if (!this.isConfigured()) throw new Error("whatsapp not configured");
    const res = await fetch(`${this.#base}/${this.#phoneId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...message }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`whatsapp ${res.status}: ${detail.slice(0, 300)}`);
    }
  }

  // ── Receiving (called by the web server webhook route) ──

  async receive(payload: MetaWebhook): Promise<void> {
    if (!this.#onMessage) {
      log.warn("inbound before start() — dropping");
      return;
    }
    // Meta batches events; walk to the messages + contact profile.
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const name = value.contacts?.[0]?.profile?.name;
        for (const m of value.messages ?? []) {
          await this.#handleMessage(m, name).catch((err) =>
            log.error({ err, from: m.from }, "inbound handler failed"),
          );
        }
      }
    }
    // Call lifecycle events arrive on the same webhook under value.calls.
    for (const call of extractCalls(payload)) {
      await this.#calling.handle(call).catch((err) =>
        log.error({ err, id: call.id }, "call handler failed"),
      );
    }
  }

  async #handleMessage(m: MetaMessage, senderName?: string): Promise<void> {
    const from = m.from;
    if (!from || !this.#onMessage) return;

    let text = "";
    let image: IncomingMessage["image"];

    switch (m.type) {
      case "text":
        text = this.#resolveChoice(from, m.text?.body ?? "");
        break;
      // A tapped interactive button/list reply carries the id we set.
      case "interactive":
        text =
          m.interactive?.button_reply?.id ??
          m.interactive?.list_reply?.id ??
          m.interactive?.button_reply?.title ??
          "";
        this.#pending.delete(from);
        break;
      // Quick-reply button on a template.
      case "button":
        text = m.button?.payload ?? m.button?.text ?? "";
        break;
      case "image": {
        const media = await this.#downloadImage(m.image?.id);
        if (!media) {
          await this.send(from, "That file doesn't look like a PNG/JPEG/WebP image.");
          return;
        }
        image = media;
        text = m.image?.caption ?? "";
        break;
      }
      case "audio": {
        if (!canTranscribe()) {
          await this.send(
            from,
            "I can't listen to voice notes just yet 🎧 — please type your message and I'll get right on it!",
          );
          return;
        }
        const spoken = await this.#transcribe(m.audio?.id);
        if (!spoken) {
          await this.send(from, "I couldn't quite catch that voice note 🎧 — mind typing it instead?");
          return;
        }
        text = spoken;
        break;
      }
      default:
        await this.send(from, "Please send me a text message to get started 😊");
        return;
    }

    await this.#onMessage({ channel: "whatsapp", chatId: from, from, text, senderName, image });
  }

  /** Map a numbered/typed reply back to a pending action id, else pass through. */
  #resolveChoice(from: string, text: string): string {
    const pending = this.#pending.get(from);
    if (!pending) return text;
    if (Date.now() - pending.at > 30 * 60_000) {
      this.#pending.delete(from);
      return text;
    }
    const trimmed = text.trim();
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 1 && n <= pending.actions.length) {
      this.#pending.delete(from);
      return pending.actions[n - 1]!.id;
    }
    const byLabel = pending.actions.find(
      (a) => a.label.toLowerCase().replace(/[^\w\s]/g, "").trim() === trimmed.toLowerCase(),
    );
    if (byLabel) {
      this.#pending.delete(from);
      return byLabel.id;
    }
    return text;
  }

  /** Two-step media fetch: media id → URL → bytes (auth on both). Validated. */
  async #downloadImage(mediaId?: string): Promise<IncomingMessage["image"] | null> {
    const buf = await this.#downloadMedia(mediaId);
    if (!buf || buf.length > 5 * 1024 * 1024) return null;
    const isPng = buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
    const isJpeg = buf.subarray(0, 3).toString("hex") === "ffd8ff";
    const isWebp =
      buf.subarray(0, 4).toString("ascii") === "RIFF" &&
      buf.subarray(8, 12).toString("ascii") === "WEBP";
    if (!isPng && !isJpeg && !isWebp) return null;
    const mime = isPng ? "image/png" : isWebp ? "image/webp" : "image/jpeg";
    return { dataUri: `data:${mime};base64,${buf.toString("base64")}`, mime };
  }

  async #transcribe(mediaId?: string): Promise<string | null> {
    if (!canTranscribe()) return null;
    const buf = await this.#downloadMedia(mediaId);
    if (!buf || buf.length > 15 * 1024 * 1024) return null;
    return transcribeAudio(buf.toString("base64"), "audio/ogg");
  }

  /** Resolve a Meta media id to bytes (the two-step Graph API media flow). */
  async #downloadMedia(mediaId?: string): Promise<Buffer | null> {
    if (!mediaId || !this.#token) return null;
    const meta = await fetch(`${this.#base}/${mediaId}`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (!meta.ok) return null;
    const url = ((await meta.json()) as { url?: string }).url;
    if (!url) return null;
    const bin = await fetch(url, { headers: { authorization: `Bearer ${this.#token}` } });
    if (!bin.ok) return null;
    return Buffer.from(await bin.arrayBuffer());
  }

  async stop(): Promise<void> {
    this.#pending.clear();
  }
}

// ── Payload shapes / helpers ──────────────────────────────

export interface MetaMessage {
  from: string;
  type: string;
  text?: { body?: string };
  interactive?: {
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  button?: { payload?: string; text?: string };
  image?: { id?: string; caption?: string };
  audio?: { id?: string };
}

export interface MetaWebhook {
  object?: string;
  entry?: {
    changes?: {
      value?: {
        contacts?: { profile?: { name?: string } }[];
        messages?: MetaMessage[];
        calls?: MetaCall[];
      };
    }[];
  }[];
}

const trunc = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 1) + "…";

/** Build the WhatsApp `interactive` object for reply buttons (≤3) or a list. */
export function interactive(text: string, actions: Action[]): Record<string, unknown> {
  if (actions.length <= 3) {
    return {
      type: "button",
      body: { text: trunc(text, 1024) },
      action: {
        buttons: actions.map((a) => ({
          type: "reply",
          reply: { id: a.id, title: trunc(a.label, 20) },
        })),
      },
    };
  }
  return {
    type: "list",
    body: { text: trunc(text, 1024) },
    action: {
      button: "Choose",
      sections: [{ rows: actions.map((a) => ({ id: a.id, title: trunc(a.label, 24) })) }],
    },
  };
}
