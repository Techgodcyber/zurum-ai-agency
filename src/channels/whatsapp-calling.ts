import { logger } from "../lib/logger.js";

/**
 * WhatsApp Business Calling API — control plane + webhook plumbing.
 *
 * Meta delivers call lifecycle events (`connect`, `terminate`, …) to the SAME
 * webhook as messages, under `value.calls`. To answer a call you POST an SDP
 * answer to `/{PHONE_NUMBER_ID}/calls`; the audio then flows over WebRTC.
 *
 * WHAT THIS FILE DOES (the plumbing, ready before Meta verification lands):
 *   - parse inbound call events,
 *   - the accept / reject / terminate control-plane calls,
 *   - a graceful "calls are coming soon — voice-note me" fallback so an inbound
 *     call is handled politely TODAY.
 *
 * WHAT IT DOESN'T (the big separate build): the real-time MEDIA bridge — taking
 * the call's live audio through STT ↔ LLM ↔ TTS with no delay. That needs a
 * WebRTC/media stack and can only really be developed against a live verified
 * number. It plugs in behind `CallMediaHandler` (null for now → polite decline).
 *
 * Field shapes follow Meta's Calling API docs; confirm against the first real
 * webhook payload (we log the raw event) and adjust if a name differs.
 */

const log = logger.child({ mod: "whatsapp-calling" });

/** One call event as delivered under webhook `value.calls[]`. */
export interface MetaCall {
  id: string;
  from?: string;
  to?: string;
  /** Lifecycle: "connect" (incoming/ringing, carries the SDP offer) | "terminate". */
  event?: string;
  status?: string;
  direction?: string; // USER_INITIATED | BUSINESS_INITIATED
  timestamp?: string;
  /** WebRTC session on connect — the caller's SDP offer. */
  session?: { sdp_type?: string; sdp?: string };
}

export type CallAction = "pre_accept" | "accept" | "reject" | "terminate";

/**
 * The seam for the future real-time voice AI. An implementation takes the
 * incoming call (with the caller's SDP offer) and returns an SDP answer to
 * accept + bridges the audio live. Returns null to decline. Null handler = no
 * live calls yet (graceful fallback).
 */
export interface CallMediaHandler {
  answer(call: MetaCall): Promise<{ sdpAnswer: string } | null>;
}

export interface CallingDeps {
  token: string;
  phoneId: string;
  base: string; // https://graph.facebook.com/vXX.X
  /** Send a WhatsApp text to a user (the channel's send). */
  sendText: (to: string, text: string) => Promise<void>;
  /** Optional real-time media bridge; when unset, inbound calls are declined politely. */
  mediaHandler?: CallMediaHandler;
}

export class WhatsAppCalling {
  #d: CallingDeps;
  constructor(deps: CallingDeps) {
    this.#d = deps;
  }

  /** Route one inbound call event from the webhook. */
  async handle(call: MetaCall): Promise<void> {
    log.info({ id: call.id, event: call.event, from: call.from, direction: call.direction }, "whatsapp call event");
    const event = (call.event ?? call.status ?? "").toLowerCase();

    // A ringing / connecting inbound call.
    if (event === "connect" || event === "ringing" || call.session?.sdp) {
      if (this.#d.mediaHandler) {
        try {
          const answer = await this.#d.mediaHandler.answer(call);
          if (answer) {
            await this.action(call.id, "accept", { sdp: answer.sdpAnswer, sdp_type: "answer" });
            return;
          }
        } catch (err) {
          log.error({ err: (err as Error).message, id: call.id }, "media handler failed — declining");
        }
      }
      // No live-call capability yet → decline gracefully + nudge to voice notes.
      await this.action(call.id, "reject").catch((err) =>
        log.warn({ err: (err as Error).message, id: call.id }, "reject failed"),
      );
      if (call.from) {
        await this.#d
          .sendText(
            call.from,
            "Hey! 💛 Live calls are coming very soon. For now, send me a voice note or a message and I'm right here with you.",
          )
          .catch(() => {});
      }
      return;
    }

    // Ended / other lifecycle — nothing to do but note it.
    log.debug({ id: call.id, event }, "call lifecycle event (no action)");
  }

  /** Control-plane: accept / reject / terminate a call via the Graph API. */
  async action(callId: string, action: CallAction, session?: { sdp: string; sdp_type: string }): Promise<void> {
    const body: Record<string, unknown> = { messaging_product: "whatsapp", call_id: callId, action };
    if (session) body.session = session;
    const res = await fetch(`${this.#d.base}/${this.#d.phoneId}/calls`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#d.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`whatsapp call ${action} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    }
  }
}

/** Pull call events out of a Meta webhook payload (same shape as messages). */
export function extractCalls(payload: {
  entry?: { changes?: { value?: { calls?: MetaCall[] } }[] }[];
}): MetaCall[] {
  const calls: MetaCall[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const c of change.value?.calls ?? []) calls.push(c);
    }
  }
  return calls;
}
