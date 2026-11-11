import { logger } from "../lib/logger.js";
import { TelegramChannel } from "./telegram.js";
import { WhatsAppChannel, type MetaWebhook } from "./whatsapp.js";
import { WebChannel, type WebReply } from "./web.js";
import type {
  Action,
  Channel,
  ChannelName,
  InboundHandler,
} from "./types.js";

const log = logger.child({ mod: "channels" });

/**
 * Channel registry + dispatcher. Owns every adapter, starts the configured ones
 * behind a single inbound handler, and sends outbound messages by channel name.
 */
export class ChannelHub {
  #channels: Record<ChannelName, Channel>;
  #whatsapp: WhatsAppChannel;
  #web: WebChannel;

  constructor() {
    this.#whatsapp = new WhatsAppChannel();
    this.#web = new WebChannel();
    this.#channels = {
      telegram: new TelegramChannel(),
      whatsapp: this.#whatsapp,
      web: this.#web, // real web-chat channel (buffered; browser long-polls)
    };
  }

  /** Deliver a customer's web-chat message into the pipeline. */
  async deliverWeb(chatId: string, text: string, senderName?: string): Promise<void> {
    await this.#web.receive(chatId, text, senderName);
  }

  /** Fetch buffered web-chat replies newer than `since` (for browser polling). */
  pollWeb(chatId: string, since: number): { messages: WebReply[]; cursor: number } {
    return this.#web.poll(chatId, since);
  }

  /** True when the Meta WhatsApp Cloud API adapter is credentialed. */
  whatsappConfigured(): boolean {
    return this.#whatsapp.isConfigured();
  }

  /** Answer Meta's GET webhook verification handshake (echo challenge). */
  verifyWhatsAppWebhook(
    mode: string | null,
    token: string | null,
    challenge: string | null,
  ): string | null {
    return this.#whatsapp.verifyWebhook(mode, token, challenge);
  }

  /** Deliver a Meta inbound webhook payload to the WhatsApp adapter. */
  async deliverWhatsApp(payload: MetaWebhook): Promise<void> {
    await this.#whatsapp.receive(payload);
  }

  /** Start all configured channels behind one inbound handler. */
  async start(onMessage: InboundHandler): Promise<void> {
    const started: ChannelName[] = [];
    for (const ch of Object.values(this.#channels)) {
      if (ch.isConfigured()) {
        await ch.start(onMessage);
        started.push(ch.name);
      }
    }
    log.info({ started }, started.length ? "channels started" : "no channels configured");
  }

  /** Send a message out on a specific channel. */
  async send(channel: ChannelName, chatId: string, text: string): Promise<void> {
    await this.#channels[channel].send(chatId, text);
  }

  /** Send a message with tappable quick-actions on a specific channel. */
  async sendActions(
    channel: ChannelName,
    chatId: string,
    text: string,
    actions: Action[],
  ): Promise<void> {
    await this.#channels[channel].sendActions(chatId, text, actions);
  }

  async stop(): Promise<void> {
    for (const ch of Object.values(this.#channels)) await ch.stop();
  }
}

export type {
  Action,
  Channel,
  ChannelName,
  IncomingMessage,
  OutgoingMessage,
  OutboundSender,
} from "./types.js";
