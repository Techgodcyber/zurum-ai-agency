/**
 * Channel-agnostic messaging core.
 *
 * The agents (Scribe, Aria) and Maestro never talk to Telegram or WhatsApp
 * directly — they speak this interface. Telegram is the first live adapter;
 * WhatsApp is a second adapter that plugs into the SAME core once Meta/BSP
 * approval lands (§9). Adding a channel is one adapter file, never a rewrite.
 */

export type ChannelName = "telegram" | "whatsapp" | "web";

/** A message arriving from a customer on some channel. */
export interface IncomingMessage {
  channel: ChannelName;
  /** Conversation id on that channel (Telegram chat id, WhatsApp phone, …). */
  chatId: string;
  /** Sender's stable id on that channel. */
  from: string;
  text: string;
  /** Display name if the channel provides one. */
  senderName?: string;
  /**
   * An uploaded image (e.g. a logo or a reference), already fetched and encoded
   * as a base64 data URI so it can be embedded directly into a self-contained
   * site without any external request.
   */
  image?: { dataUri: string; mime: string };
}

/** A message we send back to a customer. */
export interface OutgoingMessage {
  channel: ChannelName;
  chatId: string;
  text: string;
}

export type InboundHandler = (msg: IncomingMessage) => Promise<void>;

/**
 * A tappable quick-action. Rendered natively per channel (Telegram inline
 * button, WhatsApp reply button, web button). A tap comes back as an ordinary
 * inbound message whose `text` is the action's `id`, so app logic treats a tap
 * and a typed word identically.
 */
export interface Action {
  id: string;
  label: string;
}

/** Anything that can send outbound messages (the ChannelHub, or a test fake). */
export interface OutboundSender {
  send(channel: ChannelName, chatId: string, text: string): Promise<void>;
  sendActions(
    channel: ChannelName,
    chatId: string,
    text: string,
    actions: Action[],
  ): Promise<void>;
}

/** Contract every channel adapter implements. */
export interface Channel {
  readonly name: ChannelName;
  /** True when credentialed and ready to run. */
  isConfigured(): boolean;
  /** Begin receiving messages; each inbound message is passed to `onMessage`. */
  start(onMessage: InboundHandler): Promise<void>;
  /** Send a message to a chat on this channel. */
  send(chatId: string, text: string): Promise<void>;
  /** Send a message with tappable quick-actions rendered natively. */
  sendActions(chatId: string, text: string, actions: Action[]): Promise<void>;
  stop(): Promise<void>;
}
