import { InProcessQueue } from "./inproc.js";
import type { Queue } from "./types.js";

/**
 * Returns the process-wide queue. Dev uses the in-process queue; when a Redis
 * URL is wired in (deploy slice) this factory returns a BullMQ-backed queue
 * implementing the same interface.
 */
let queue: Queue | null = null;

export function getQueue(): Queue {
  if (!queue) queue = new InProcessQueue();
  return queue;
}

export type { Queue, JobHandler } from "./types.js";
