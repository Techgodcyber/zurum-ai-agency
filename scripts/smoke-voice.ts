/**
 * Cheap (Haiku-only) check that Zurum talks naturally and mirrors the customer's
 * language — including Nigerian Pidgin and French. Does NOT run Forge/Opus, so
 * it costs a fraction of a cent.
 *
 * Run: npm run smoke:voice
 */
import { runScribe } from "../src/agents/scribe.js";
import { phrase } from "../src/agents/voice.js";

async function main() {
  console.log("── Scribe replies in the customer's language ──");

  const pidgin = await runScribe([
    {
      role: "user",
      content:
        "abeg i wan make website for my provision store, e get where people fit see my products and call me",
    },
  ]);
  console.log(`\n🙋 (Pidgin) → abeg i wan make website for my provision store...`);
  console.log(`🤖 Scribe → ${pidgin.reply}${pidgin.done ? ` [spec: ${pidgin.spec}]` : ""}`);

  const french = await runScribe([
    { role: "user", content: "bonjour, je veux un site web pour ma boulangerie" },
  ]);
  console.log(`\n🙋 (French) → bonjour, je veux un site web pour ma boulangerie`);
  console.log(`🤖 Scribe → ${french.reply}${french.done ? ` [spec: ${french.spec}]` : ""}`);

  console.log("\n── Voice layer phrases system messages in their language ──");
  const v1 = await phrase(
    "Tell them their website preview is ready to look at.",
    "abeg i wan website for my shop",
  );
  console.log(`\n(Pidgin context) preview-ready → ${v1}`);

  const v2 = await phrase(
    "Tell them you're on it, applying that change now.",
    "je veux changer la couleur en vert",
  );
  console.log(`(French context) on-it → ${v2}`);

  console.log("\n(Eyeball the replies above — they should be natural and in the same language.)");
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
