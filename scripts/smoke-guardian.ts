/**
 * Guardian smoke test. Proves the gate:
 *   1. The real Forge-generated bakery site PASSES.
 *   2. A site with an external resource is caught (self-containment / security).
 *   3. A self-contained but PHISHING site is BLOCKED (content moderation).
 *
 * Run: npm run smoke:guardian   (run smoke:forge first so the good site exists)
 */
import { review } from "../src/agents/guardian.js";
import { readSite } from "../src/sites/store.js";

const EXTERNAL_RESOURCE = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width">
<title>Test</title><script src="https://evil.example.com/x.js"></script></head>
<body><h1>Hello</h1><p>${"padding ".repeat(120)}</p></body></html>`;

const PHISHING = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width">
<title>Bank of America — Sign In</title><style>body{font-family:sans-serif}</style></head>
<body><h1>Bank of America</h1><p>Please sign in to verify your account.</p>
<form><label>Online ID</label><input><label>Passcode</label><input type="password">
<button>Sign In</button></form><p>${"Enter your banking credentials to continue. ".repeat(30)}</p>
</body></html>`;

async function report(label: string, html: string) {
  const r = await review(html);
  console.log(
    `\n${label}\n  passed=${r.passed} critical=${r.critical}\n  issues: ${
      r.issues.length ? r.issues.join(" | ") : "none"
    }`,
  );
  return r;
}

async function main() {
  const good = await readSite("forge-demo");
  if (!good) {
    console.error("Run `npm run smoke:forge` first to generate the good site.");
    process.exit(1);
  }

  const g = await report("1) Real bakery site (should PASS)", good);
  const e = await report("2) External-resource site (should be CRITICAL)", EXTERNAL_RESOURCE);
  const p = await report("3) Phishing bank site (should be BLOCKED)", PHISHING);

  console.log("\n── results ─────────────────────────────────");
  console.log(`  good site passes:        ${g.passed && !g.critical ? "PASS" : "FAIL"}`);
  console.log(`  external resource caught:${e.critical ? " PASS" : " FAIL"}`);
  console.log(`  phishing blocked:        ${p.critical ? "PASS" : "FAIL"}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
