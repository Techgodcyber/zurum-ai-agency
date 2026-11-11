import { test } from "node:test";
import assert from "node:assert/strict";
import { WhatsAppCalling, extractCalls } from "../src/channels/whatsapp-calling.js";

/** Swap global fetch for a recorder; returns the captured requests. */
function mockFetch(): { url: string; body: Record<string, unknown> }[] {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: unknown, opts: { body?: string }) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body ?? "{}") });
    return { ok: true, text: async () => "" } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

const deps = (extra: object = {}) => ({
  token: "t",
  phoneId: "p",
  base: "https://graph.facebook.com/v21.0",
  sendText: async () => {},
  ...extra,
});

test("extractCalls pulls call events out of a webhook payload", () => {
  const calls = extractCalls({
    entry: [{ changes: [{ value: { calls: [{ id: "c1", event: "connect", from: "234800" }] } }] }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, "c1");
});

test("inbound call with NO media handler → reject + a friendly voice-note nudge", async () => {
  const fetches = mockFetch();
  const sent: { to: string; text: string }[] = [];
  const wc = new WhatsAppCalling(deps({ sendText: async (to: string, text: string) => void sent.push({ to, text }) }));
  await wc.handle({ id: "c1", event: "connect", from: "234800", session: { sdp_type: "offer", sdp: "..." } });

  assert.ok(fetches.some((f) => f.body.action === "reject" && f.body.call_id === "c1"), "rejects the call");
  assert.equal(sent.length, 1, "sends one nudge message");
  assert.match(sent[0]!.text, /voice note|coming/i);
});

test("inbound call WITH a media handler → accept with the SDP answer", async () => {
  const fetches = mockFetch();
  const wc = new WhatsAppCalling(deps({ mediaHandler: { answer: async () => ({ sdpAnswer: "v=0-answer" }) } }));
  await wc.handle({ id: "c2", event: "connect", from: "234800", session: { sdp_type: "offer", sdp: "offer" } });

  const accept = fetches.find((f) => f.body.action === "accept");
  assert.ok(accept, "accepts the call");
  assert.equal((accept!.body.session as { sdp: string }).sdp, "v=0-answer");
});

test("terminate event makes no control-plane call", async () => {
  const fetches = mockFetch();
  const wc = new WhatsAppCalling(deps());
  await wc.handle({ id: "c3", event: "terminate" });
  assert.equal(fetches.length, 0);
});
