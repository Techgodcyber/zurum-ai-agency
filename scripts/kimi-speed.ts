/** Times each Kimi model on a tiny chat prompt to find the fastest. Run: tsx scripts/kimi-speed.ts */
import { env } from "../src/config/env.js";

const MODELS = ["kimi-k3", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"];
const base = env.KIMI_BASE_URL.replace(/\/$/, "");

async function time(model: string): Promise<string> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.KIMI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with one short friendly sentence." }],
        max_tokens: 50,
      }),
    });
    const ms = Date.now() - t0;
    if (!res.ok) return `${model.padEnd(28)} ERROR ${res.status} (${ms}ms)`;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return `${model.padEnd(28)} ${String(ms).padStart(6)}ms  "${data.choices?.[0]?.message?.content?.trim().slice(0, 40)}"`;
  } catch (e) {
    return `${model.padEnd(28)} FAILED ${(Date.now() - t0)}ms ${e}`;
  }
}

async function main() {
  console.log("Timing Kimi models (short prompt)…\n");
  for (const m of MODELS) console.log(await time(m)); // sequential = fair timing
}
main().catch(console.error);
