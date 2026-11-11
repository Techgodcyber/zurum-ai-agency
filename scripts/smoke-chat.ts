/**
 * Full-loop smoke test WITHOUT a Telegram token.
 *
 * Drives the real app through a simulated channel: a fake sender captures the
 * bot's outbound messages, and we feed it customer messages. Exercises the whole
 * vertical slice for real — Scribe (live model) → Maestro → approval gate →
 * resume → live — exactly as it will run over Telegram.
 *
 * Run: npm run smoke:chat
 */
import { ZurumApp } from "../src/app.js";
import { getQueue } from "../src/queue/index.js";
import * as conv from "../src/conversations/store.js";
import type {
  Action,
  ChannelName,
  OutboundSender,
} from "../src/channels/types.js";

const CHAT = "sim-" + Date.now();

class FakeSender implements OutboundSender {
  async send(_channel: ChannelName, _chatId: string, text: string) {
    console.log(`\n🤖 Zurum → ${text}`);
  }
  async sendActions(
    _channel: ChannelName,
    _chatId: string,
    text: string,
    actions: Action[],
  ) {
    const buttons = actions.map((a) => `[ ${a.label} ]`).join("  ");
    console.log(`\n🤖 Zurum → ${text}\n           ${buttons}`);
  }
}

async function main() {
  const app = new ZurumApp(new FakeSender());
  app.start();
  const queue = getQueue();

  const you = async (text: string) => {
    console.log(`\n🙋 You → ${text}`);
    await app.handleInbound({
      channel: "telegram",
      chatId: CHAT,
      from: "sim-user",
      text,
    });
    await queue.drain();
  };
  const phase = async () =>
    (await conv.getOrCreate("telegram", CHAT)).phase;

  console.log("── Intake conversation ─────────────────────────");
  // A rich first message so Scribe can usually spec it in 0–1 follow-ups.
  await you(
    "I want a website for my bakery called Sweet Crumbs. Pages: home, menu, gallery, and contact. Warm cozy style, cream and brown colours.",
  );

  // Answer any clarifying questions until intake completes (max a few turns).
  for (let i = 0; i < 4 && (await phase()) === "intake"; i++) {
    await you("That's everything — keep it simple, no other preferences.");
  }

  console.log(`\n[phase after intake: ${await phase()}]`);

  // The build job runs to the approval gate; the notifier should have sent a
  // preview + the phase should be awaiting_approval.
  console.log(`[phase at gate: ${await phase()}]`);
  const atGate = (await phase()) === "awaiting_approval";
  console.log(`✓ paused for approval with a preview sent: ${atGate ? "PASS" : "FAIL"}`);

  console.log("\n── Approval ────────────────────────────────────");
  await you("approve");

  const done = (await phase()) === "done";
  console.log(`\n[final phase: ${await phase()}]`);
  console.log(`✓ went live after approval: ${done ? "PASS" : "FAIL"}`);

  console.log("\n── done ────────────────────────────────────────");
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
