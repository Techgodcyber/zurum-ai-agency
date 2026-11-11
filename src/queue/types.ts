/**
 * Job queue abstraction. Maestro enqueues a job id; the queue drives a worker
 * that loads the job from Postgres and runs it. The DB is the source of truth —
 * the queue only signals "there is work to do".
 *
 * Dev impl: in-process (queue/inproc.ts). Prod: BullMQ on Redis (added with the
 * deploy slice) implements this same interface, so nothing above the queue
 * changes when we switch.
 */
export type JobHandler = (jobId: string) => Promise<void>;

export interface Queue {
  /** Register the worker that processes each job id. Call once at startup. */
  process(handler: JobHandler): void;
  /** Signal that a job is ready to be worked. */
  enqueue(jobId: string): Promise<void>;
  /** Resolve once all in-flight work is done (dev/testing convenience). */
  drain(): Promise<void>;
  close(): Promise<void>;
}
