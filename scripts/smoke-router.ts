/**
 * Smoke test for the model-router.
 *
 *  - Prints which providers are live.
 *  - Prints the resolved failover ladder for every agent role.
 *  - If ANTHROPIC_API_KEY is set, makes one cheap real call (Aria/Haiku) and a
 *    failover call (Forge-design: Kimi primary is pending → falls back to Claude)
 *    to prove the ladder end-to-end.
 *
 * Run: npm run smoke:router
 */
import { availableProviders, callModel, ladderFor } from "../src/models/index.js";
import type { AgentRole } from "../src/models/index.js";

const ROLES: AgentRole[] = [
  "maestro",
  "scribe",
  "forge-design",
  "forge-logic",
  "guardian",
  "launch",
  "aria",
];

async function main() {
  console.log("Available providers:", availableProviders());
  console.log("\nRouting ladders:");
  for (const role of ROLES) {
    const ladder = ladderFor(role)
      .map((s) => `${s.provider}:${s.model}${s.effort ? `(${s.effort})` : ""}`)
      .join("  →  ");
    console.log(`  ${role.padEnd(13)} ${ladder}`);
  }

  if (!availableProviders().includes("anthropic")) {
    console.log(
      "\n(no ANTHROPIC_API_KEY set — skipping live calls; routing wiring verified)",
    );
    return;
  }

  console.log("\nLive call — Aria (Haiku, cheap):");
  const aria = await callModel("aria", {
    system: "You are Aria, a concise support assistant for a web agency.",
    messages: [{ role: "user", content: "In one short sentence, say hello." }],
    maxTokens: 64,
    jobId: "smoke-aria",
  });
  console.log(`  model=${aria.spec.provider}:${aria.spec.model} depth=${aria.fallbackDepth}`);
  console.log(`  cost≈$${aria.costUsd.toFixed(6)}  text="${aria.text.trim()}"`);

  console.log("\nLive call — Forge-design (Kimi pending → Claude fallback):");
  const forge = await callModel("forge-design", {
    system: "You are Forge, a web design assistant.",
    messages: [{ role: "user", content: "Name one good font pairing. One line." }],
    maxTokens: 64,
    jobId: "smoke-forge",
  });
  console.log(
    `  model=${forge.spec.provider}:${forge.spec.model} depth=${forge.fallbackDepth} (0=primary, >0=fell back)`,
  );
  console.log(`  cost≈$${forge.costUsd.toFixed(6)}  text="${forge.text.trim()}"`);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
