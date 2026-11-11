import { logger } from "../lib/logger.js";
import type { JobHandler, Queue } from "./types.js";

const log = logger.child({ mod: "queue" });

/**
 * In-process queue for local development. Runs jobs in the same Node process
 * with bounded concurrency. Jobs enqueued before a processor is registered are
 * buffered and flushed once `process()` is called. `drain()` waits for the
 * backlog and all in-flight jobs to finish — handy for scripts and tests.
 */
export class InProcessQueue implements Queue {
  #handler: JobHandler | null = null;
  #buffer: string[] = [];
  #inFlight = new Set<Promise<void>>();
  #concurrency: number;
  #active = 0;
  #pending: string[] = [];

  constructor(concurrency = 4) {
    this.#concurrency = concurrency;
  }

  process(handler: JobHandler): void {
    this.#handler = handler;
    const buffered = this.#buffer;
    this.#buffer = [];
    for (const id of buffered) void this.enqueue(id);
  }

  async enqueue(jobId: string): Promise<void> {
    if (!this.#handler) {
      this.#buffer.push(jobId);
      return;
    }
    this.#pending.push(jobId);
    this.#pump();
  }

  #pump(): void {
    while (this.#active < this.#concurrency && this.#pending.length > 0) {
      const jobId = this.#pending.shift()!;
      const handler = this.#handler!;
      this.#active++;
      const p = handler(jobId)
        .catch((err) => log.error({ jobId, err }, "job handler threw"))
        .finally(() => {
          this.#active--;
          this.#inFlight.delete(p);
          this.#pump();
        });
      this.#inFlight.add(p);
    }
  }

  async drain(): Promise<void> {
    while (this.#inFlight.size > 0 || this.#pending.length > 0) {
      await Promise.all([...this.#inFlight]);
    }
  }

  async close(): Promise<void> {
    await this.drain();
  }
}
