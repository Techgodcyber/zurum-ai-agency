import type { Job } from "../db/jobs.js";

/** Context handed to each pipeline step. */
export interface StepContext {
  job: Job;
  /** Mutable accumulator of step outputs (spec, preview URL, …). Persisted. */
  data: Record<string, unknown>;
  /** Report model spend so the sentinel + cost instrumentation can track it. */
  addCost(usd: number, tokens: number): void;
  /** Aborts when the sentinel's wall-clock cap trips — pass to model calls. */
  signal: AbortSignal;
}

/** A step returns outputs to merge into the job's checkpoint data. */
export type StepFn = (
  ctx: StepContext,
) => Promise<Record<string, unknown> | void>;

export interface Step {
  name: string;
  /**
   * A gate step pauses the job for an external event (e.g. HUMAN APPROVAL of the
   * preview before any spend — §5). When reached and not yet cleared, the job is
   * parked in `awaiting_approval` and the loop returns.
   */
  gate?: boolean;
  run?: StepFn;
}

/**
 * Hooks Maestro calls at key job transitions so the app can message the customer
 * (preview ready → approve; live; failed). Kept channel-agnostic — the app maps
 * the job back to its conversation/channel.
 */
export interface JobNotifier {
  onAwaitingApproval(job: Job): Promise<void>;
  onCompleted(job: Job): Promise<void>;
  onFailed(job: Job): Promise<void>;
}

/** Caps enforced by the runaway sentinel (§8 — "who watches the watcher"). */
export interface SentinelCaps {
  maxSteps: number;
  maxCostUsd: number;
  maxWallMs: number;
}

export const DEFAULT_CAPS: SentinelCaps = {
  maxSteps: 20,
  maxCostUsd: 5,
  // Rich Sonnet builds (big HTML + a truncation retry + waiting for the deploy to
  // go live) can legitimately take a few minutes. 5 min gives real headroom while
  // still failing a genuinely stuck job honestly instead of hanging forever.
  maxWallMs: 5 * 60_000,
};
