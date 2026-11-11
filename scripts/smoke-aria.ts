/**
 * Cheap check that Aria classifies post-preview intent correctly (the bug where
 * "hello" triggered a rebuild). No site builds — just the Aria decision call.
 *
 * Run: npm run smoke:aria
 */
import { runAria } from "../src/agents/aria.js";

const CASES: { msg: string; expect: string }[] = [
  { msg: "hello", expect: "chat" },
  { msg: "how are you doing?", expect: "chat" },
  { msg: "i am satisfied, do not build it again", expect: "chat" },
  { msg: "make the background green", expect: "edit" },
  { msg: "add a contact form and a booking section", expect: "edit" },
  { msg: "looks great, publish it", expect: "approve" },
  { msg: "how far, this one wey you build fine well well", expect: "chat" }, // pidgin praise
  { msg: "build me a beautiful online banking frontend instead", expect: "new" },
  { msg: "actually make me a totally different site, a photography portfolio", expect: "new" },
  { msg: "send me the link to my site", expect: "link" },
  { msg: "where is my website?", expect: "link" },
];

async function main() {
  let pass = 0;
  for (const c of CASES) {
    const r = await runAria(c.msg);
    const ok = r.action === c.expect;
    if (ok) pass++;
    console.log(
      `${ok ? "✓" : "✗"} "${c.msg}"\n    → action=${r.action}${r.change ? ` change="${r.change}"` : ""}  expected=${c.expect}\n    reply: ${r.reply}`,
    );
  }
  console.log(`\n${pass}/${CASES.length} correct`);
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
