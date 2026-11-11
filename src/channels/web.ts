import type { Action, Channel, InboundHandler } from "./types.js";

/**
 * Web-chat channel. The agent pipeline replies asynchronously via send()/
 * sendActions() (a build can finish minutes later), and the browser has no push
 * connection — so replies are BUFFERED per chat (the logged-in customer's user
 * id) and the browser long-polls them. Always "configured": no credentials, it's
 * just an in-process mailbox.
 */
export interface WebReply {
  id: number;
  role: "user" | "ai";
  text: string;
  actions?: Action[];
}

export class WebChannel implements Channel {
  readonly name = "web" as const;
  #onMessage: InboundHandler | null = null;
  #buffers = new Map<string, { seq: number; msgs: WebReply[] }>();
  readonly #MAX = 200; // keep the last N messages (both sides) per chat

  isConfigured(): boolean {
    return true;
  }
  async start(onMessage: InboundHandler): Promise<void> {
    this.#onMessage = onMessage;
  }
  async stop(): Promise<void> {
    this.#buffers.clear();
  }

  async send(chatId: string, text: string): Promise<void> {
    this.#push(chatId, "ai", { text });
  }
  async sendActions(chatId: string, text: string, actions: Action[]): Promise<void> {
    this.#push(chatId, "ai", { text, actions });
  }

  #push(chatId: string, role: "user" | "ai", m: { text: string; actions?: Action[] }): void {
    const b = this.#buffers.get(chatId) ?? { seq: 0, msgs: [] };
    b.seq += 1;
    b.msgs.push({ id: b.seq, role, text: m.text, actions: m.actions });
    if (b.msgs.length > this.#MAX) b.msgs.splice(0, b.msgs.length - this.#MAX);
    this.#buffers.set(chatId, b);
  }

  /** Deliver an inbound web message into the pipeline (same handler as WhatsApp). */
  async receive(chatId: string, text: string, senderName?: string): Promise<void> {
    if (!this.#onMessage) return;
    this.#push(chatId, "user", { text }); // record the customer's own message so it survives a reload
    await this.#onMessage({ channel: "web", chatId, from: chatId, text, senderName });
  }

  /** Buffered replies newer than `since` (a reply id) + the new cursor. */
  poll(chatId: string, since: number): { messages: WebReply[]; cursor: number } {
    const b = this.#buffers.get(chatId);
    if (!b) return { messages: [], cursor: since };
    return { messages: b.msgs.filter((m) => m.id > since), cursor: b.seq };
  }
}
