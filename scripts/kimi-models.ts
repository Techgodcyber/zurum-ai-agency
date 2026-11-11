/** Lists the Moonshot/Kimi models this API key can access. Run: tsx scripts/kimi-models.ts */
import { env } from "../src/config/env.js";

async function main() {
  const base = env.KIMI_BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/models`, {
    headers: { authorization: `Bearer ${env.KIMI_API_KEY}` },
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, await res.text());
    process.exit(1);
  }
  const data = (await res.json()) as { data?: { id: string }[] };
  console.log("Available Kimi models:");
  for (const m of data.data ?? []) console.log("  -", m.id);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
