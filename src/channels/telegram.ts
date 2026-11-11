import { Bot, InlineKeyboard } from "grammy";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { transcribeAudio, canTranscribe } from "../media/transcribe.js";
import type { Action, Channel, InboundHandler } from "./types.js";

const log = logger.child({ mod: "telegram" });

/**
 * Telegram adapter (live). Uses grammY long-polling — free, instant, no approval
 * or gatekeeper, which is why it's the first channel (§9). Requires a bot token
 * from @BotFather in TELEGRAM_BOT_TOKEN.
 */
export class TelegramChannel implements Channel {
  readonly name = "telegram" as const;
  #bot: Bot | null;

  constructor() {
    this.#bot = env.TELEGRAM_BOT_TOKEN ? new Bot(env.TELEGRAM_BOT_TOKEN) : null;
  }

  isConfigured(): boolean {
    return this.#bot !== null;
  }

  async start(onMessage: InboundHandler): Promise<void> {
    if (!this.#bot) {
      log.warn("TELEGRAM_BOT_TOKEN not set — Telegram channel disabled");
      return;
    }
    const bot = this.#bot;

    bot.on("message:text", async (ctx) => {
      const chatId = String(ctx.chat.id);
      try {
        await onMessage({
          channel: "telegram",
          chatId,
          from: String(ctx.from?.id ?? chatId),
          text: ctx.message.text,
          senderName: ctx.from?.first_name,
        });
      } catch (err) {
        log.error({ err, chatId }, "inbound handler failed");
        await ctx.reply("Sorry — something went wrong. Please try again.");
      }
    });

    // Photo uploads (e.g. a logo). Download it and pass it on as a data URI so
    // it can be embedded into the generated site.
    bot.on("message:photo", async (ctx) => {
      const chatId = String(ctx.chat.id);
      try {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1]!; // highest resolution
        const file = await ctx.api.getFile(largest.file_id);
        if (!file.file_path) throw new Error("no file_path from telegram");
        const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());

        // Upload safety: cap size and verify it's really an image by its file
        // signature (magic bytes) — never trust the extension alone.
        const MAX_BYTES = 5 * 1024 * 1024;
        if (buf.length > MAX_BYTES) {
          await ctx.reply("That image is too large — please send one under 5MB.");
          return;
        }
        const isPng = buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
        const isJpeg = buf.subarray(0, 3).toString("hex") === "ffd8ff";
        const isWebp =
          buf.subarray(0, 4).toString("ascii") === "RIFF" &&
          buf.subarray(8, 12).toString("ascii") === "WEBP";
        if (!isPng && !isJpeg && !isWebp) {
          await ctx.reply("That file doesn't look like a PNG/JPEG/WebP image.");
          return;
        }
        const mime = isPng ? "image/png" : isWebp ? "image/webp" : "image/jpeg";
        await onMessage({
          channel: "telegram",
          chatId,
          from: String(ctx.from?.id ?? chatId),
          text: ctx.message.caption ?? "",
          senderName: ctx.from?.first_name,
          image: { dataUri: `data:${mime};base64,${buf.toString("base64")}`, mime },
        });
      } catch (err) {
        log.error({ err, chatId }, "photo handler failed");
        await ctx.reply("Sorry — I couldn't read that image. Please try again.");
      }
    });

    // Voice notes (and audio files): transcribe to text, then handle like a
    // normal typed message — so someone can just talk to Zurum.
    bot.on(["message:voice", "message:audio"], async (ctx) => {
      const chatId = String(ctx.chat.id);
      if (!canTranscribe()) {
        await ctx.reply("I can't listen to voice notes yet — please type your message.");
        return;
      }
      try {
        const media = ctx.message.voice ?? ctx.message.audio;
        if (!media) return;
        if ((media.file_size ?? 0) > 15 * 1024 * 1024) {
          await ctx.reply("That voice note is a bit long — please keep it under ~10 minutes.");
          return;
        }
        await ctx.replyWithChatAction("typing");
        const file = await ctx.api.getFile(media.file_id);
        if (!file.file_path) throw new Error("no file_path");
        const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        const mime = media.mime_type ?? "audio/ogg";
        const text = await transcribeAudio(buf.toString("base64"), mime);
        if (!text) {
          await ctx.reply("I couldn't quite catch that — could you say it again or type it?");
          return;
        }
        await onMessage({
          channel: "telegram",
          chatId,
          from: String(ctx.from?.id ?? chatId),
          text,
          senderName: ctx.from?.first_name,
        });
      } catch (err) {
        log.error({ err, chatId }, "voice handler failed");
        await ctx.reply("Sorry — I had trouble with that voice note. Please try again or type it.");
      }
    });

    // A tapped inline button arrives as a callback — treat its data as a message.
    bot.on("callback_query:data", async (ctx) => {
      const chatId = String(ctx.chat?.id ?? ctx.from.id);
      await ctx.answerCallbackQuery(); // stop the loading spinner
      try {
        await onMessage({
          channel: "telegram",
          chatId,
          from: String(ctx.from.id),
          text: ctx.callbackQuery.data,
          senderName: ctx.from.first_name,
        });
      } catch (err) {
        log.error({ err, chatId }, "callback handler failed");
      }
    });

    bot.catch((err) => log.error({ err: err.message }, "grammy error"));

    // start() runs the long-poll loop; don't await (it resolves on stop()).
    void bot.start({
      onStart: (info) => log.info({ username: info.username }, "telegram bot online"),
    });
  }

  async send(chatId: string, text: string): Promise<void> {
    if (!this.#bot) throw new Error("telegram not configured");
    await this.#bot.api.sendMessage(chatId, text);
  }

  async sendActions(
    chatId: string,
    text: string,
    actions: Action[],
  ): Promise<void> {
    if (!this.#bot) throw new Error("telegram not configured");
    const kb = new InlineKeyboard();
    for (const a of actions) kb.text(a.label, a.id);
    await this.#bot.api.sendMessage(chatId, text, { reply_markup: kb });
  }

  async stop(): Promise<void> {
    await this.#bot?.stop();
  }
}
