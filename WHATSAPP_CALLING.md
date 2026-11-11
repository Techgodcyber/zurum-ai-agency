# WhatsApp Business Calling — setup & status

## What's built (the plumbing — ready now)
- `src/channels/whatsapp-calling.ts` — parses inbound call webhook events, the
  accept/reject/terminate control plane (`POST /{PHONE_NUMBER_ID}/calls`), and a
  graceful fallback.
- Wired into `src/channels/whatsapp.ts` `receive()` — call events on the shared
  webhook (`value.calls`) are routed automatically.
- **Today's behavior:** an inbound call is **politely declined** and the caller
  gets *"Live calls are coming very soon — voice-note me"*. Nothing breaks.
- Tests: `tests/whatsapp-calling.test.ts` (4/4).

## What's NOT built (the big, separate piece)
The **real-time audio bridge** — taking the live call audio through STT ↔ LLM ↔
TTS with no delay over WebRTC. It plugs in behind the `CallMediaHandler` interface
(currently unset → polite decline). This needs a media/WebRTC stack and can only
really be developed against a **live, verified** number. Best home for it: the
mobile app (or a dedicated media server) — not required to launch.

## To turn calling ON (Meta side) once you're verified
1. **Finish Business Verification** — calling is an advanced feature and is almost
   certainly gated on it. (Meta Business Manager → Security Center / Business Verification.)
2. **Enable calling on the phone number** — WhatsApp Manager → Phone numbers → your
   number → **Calling** → enable. (Or via the API on the phone number's settings.)
3. **Subscribe the webhook to the `calls` field** — in the app's Webhooks config for
   the WhatsApp product, tick **`calls`** (alongside `messages`). Same callback URL.
4. That's it — inbound calls then hit our webhook and get the polite decline until
   the media bridge is built.

## Region + direction rules (confirmed earlier)
- **User-initiated** calls (customer calls you) are **FREE** and allowed **from
  Nigerian numbers** — this is the case we want.
- **Business-initiated** (you call them) is **blocked from Nigerian numbers**.
- **Video** is not GA yet (voice only).

## ⚠️ Product caution
Do NOT run the **romantic companion** on this (business) WhatsApp / Business Manager
— Meta's policy on romantic/adult content could ban the WABA and take the working
business number down with it. Keep romantic Personal on Telegram or a separate entity.

## Field-shape note
The `MetaCall` webhook shape follows Meta's docs but isn't verified against a live
payload yet. We **log the raw call event**, so on the first real call, check the log
and adjust field names in `whatsapp-calling.ts` if anything differs.
