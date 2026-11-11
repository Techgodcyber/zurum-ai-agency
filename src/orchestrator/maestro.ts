import { logger } from "../lib/logger.js";
import { getQueue, type Queue } from "../queue/index.js";
import {
  createJob,
  getJob,
  saveCheckpoint,
  setState,
  type Checkpoint,
  type Job,
} from "../db/jobs.js";
import { BUILD_PIPELINE, EDIT_PIPELINE } from "./pipeline.js";
import type { JobType } from "../db/jobs.js";
import {
  DEFAULT_CAPS,
  type JobNotifier,
  type SentinelCaps,
  type Step,
} from "./types.js";

const log = logger.child({ mod: "maestro" });

/**
 * Maestro — the orchestrator ("CEO"). Runs each job through its pipeline,
 * checkpointing after every step so a crash or the runaway sentinel can resume
 * from the last good step. Pauses at the human-approval gate before any spend,
 * and kills any job that blows past its step/cost/time caps (§8).
 */
export class Maestro {
  #queue: Queue;
  #override: Step[] | null;
  #pipelines: Record<JobType, Step[]>;
  #caps: SentinelCaps;
  #notifier: JobNotifier | null;

  constructor(opts?: {
    /** Test-only: force one pipeline for every job type. */
    pipeline?: Step[];
    caps?: Partial<SentinelCaps>;
    notifier?: JobNotifier;
  }) {
    this.#queue = getQueue();
    this.#override = opts?.pipeline ?? null;
    this.#pipelines = {
      build: BUILD_PIPELINE,
      edit: EDIT_PIPELINE,
      deploy: BUILD_PIPELINE,
    };
    this.#caps = { ...DEFAULT_CAPS, ...opts?.caps };
    this.#notifier = opts?.notifier ?? null;
  }

  #pipelineFor(type: JobType): Step[] {
    return this.#override ?? this.#pipelines[type];
  }

  /** Fire a notifier hook without letting a notify failure break the job. */
  async #notify(
    hook: keyof JobNotifier,
    jobId: string,
  ): Promise<void> {
    if (!this.#notifier) return;
    try {
      const fresh = await getJob(jobId);
      if (fresh) await this.#notifier[hook](fresh);
    } catch (err) {
      log.error({ jobId, hook, err }, "notifier failed");
    }
  }

  /** Register the worker. Call once at startup. */
  start(): void {
    this.#queue.process((jobId) => this.runJob(jobId));
    log.info(
      { steps: this.#pipelineFor("build").map((s) => s.name) },
      "maestro started",
    );
  }

  /** Submit a new build job and enqueue it. Returns the job id. */
  async submit(input: Record<string, unknown>): Promise<string> {
    const job = await createJob({ type: "build", input });
    await this.#queue.enqueue(job.id);
    return job.id;
  }

  /**
   * Submit an EDIT of an existing site. `input.baseJobId` is the job whose site
   * to modify; `input.description` is the requested change. Returns the new job id.
   */
  async submitEdit(input: Record<string, unknown>): Promise<string> {
    const job = await createJob({ type: "edit", input });
    await this.#queue.enqueue(job.id);
    return job.id;
  }

  /** Clear the approval gate and resume the job (called after the customer ✅). */
  async approve(jobId: string): Promise<void> {
    const job = await getJob(jobId);
    if (!job) throw new Error(`approve: job ${jobId} not found`);
    const cp = job.checkpoint;
    cp.data["approved"] = true;
    await saveCheckpoint(jobId, cp, job.costUsd, job.costTokens);
    await setState(jobId, "queued");
    await this.#queue.enqueue(jobId);
    log.info({ jobId }, "approval granted, resuming");
  }

  /** Run (or resume) a job through the pipeline. */
  async runJob(jobId: string): Promise<void> {
    const job = await getJob(jobId);
    if (!job) return void log.warn({ jobId }, "runJob: not found");
    if (job.state === "completed" || job.state === "failed") return;

    const cp: Checkpoint = {
      completedSteps: job.checkpoint.completedSteps ?? [],
      data: job.checkpoint.data ?? {},
      startedAt: job.checkpoint.startedAt ?? new Date().toISOString(),
    };

    // Running cost totals (seeded from prior runs so resume keeps the tally).
    let costUsd = job.costUsd;
    let costTokens = job.costTokens;

    const controller = new AbortController();
    const wallTimer = setTimeout(
      () => controller.abort(),
      this.#caps.maxWallMs,
    );

    try {
      await setState(jobId, "running");

      for (const step of this.#pipelineFor(job.type)) {
        if (cp.completedSteps.includes(step.name)) continue; // resume: skip done

        // ── Runaway sentinel: guard BEFORE running the step ──
        const breach = this.#sentinelBreach(cp, costUsd);
        if (breach) {
          clearTimeout(wallTimer);
          await setState(jobId, "failed", `runaway sentinel: ${breach}`);
          log.error({ jobId, breach, costUsd }, "🛡️ sentinel killed job");
          await this.#notify("onFailed", jobId);
          return;
        }

        // ── Human-approval gate ──
        if (step.gate) {
          if (cp.data["approved"] !== true) {
            clearTimeout(wallTimer);
            await saveCheckpoint(jobId, cp, costUsd, costTokens);
            await setState(jobId, "awaiting_approval");
            log.info({ jobId, step: step.name }, "paused for approval");
            await this.#notify("onAwaitingApproval", jobId);
            return;
          }
          cp.completedSteps.push(step.name);
          await saveCheckpoint(jobId, cp, costUsd, costTokens);
          continue;
        }

        // ── Normal step ──
        const output = await step.run!({
          job,
          data: cp.data,
          signal: controller.signal,
          addCost: (usd, tokens) => {
            costUsd += usd;
            costTokens += tokens;
          },
        });
        if (output) Object.assign(cp.data, output);
        cp.completedSteps.push(step.name);
        await saveCheckpoint(jobId, cp, costUsd, costTokens);
        log.info(
          { jobId, step: step.name, costUsd: Number(costUsd.toFixed(6)) },
          "step done",
        );
      }

      clearTimeout(wallTimer);
      await setState(jobId, "completed");
      log.info({ jobId, costUsd: Number(costUsd.toFixed(6)) }, "job completed");
      await this.#notify("onCompleted", jobId);
    } catch (err) {
      clearTimeout(wallTimer);
      const aborted = controller.signal.aborted;
      const message = aborted
        ? "runaway sentinel: wall-clock cap exceeded"
        : err instanceof Error
          ? err.message
          : String(err);
      // Persist whatever progress we made before failing (don't lose the cost).
      await saveCheckpoint(jobId, cp, costUsd, costTokens);
      await setState(jobId, "failed", message);
      log.error({ jobId, err: message }, "job failed");
      await this.#notify("onFailed", jobId);
    }
  }

  #sentinelBreach(cp: Checkpoint, costUsd: number): string | null {
    if (cp.completedSteps.length >= this.#caps.maxSteps) return "step cap";
    if (costUsd >= this.#caps.maxCostUsd) return "cost cap";
    if (cp.startedAt) {
      const elapsed = Date.now() - new Date(cp.startedAt).getTime();
      if (elapsed >= this.#caps.maxWallMs) return "time cap";
    }
    return null;
  }
}
