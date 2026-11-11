import { getDb } from "./index.js";

/** Lifecycle states a job moves through (mirrors the DB CHECK constraint). */
export type JobState =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "paused";

export type JobType = "build" | "edit" | "deploy";

/**
 * Checkpoint stored on the job row. Maestro writes this after every pipeline
 * step so a crash (or the runaway sentinel) can resume from the last good step
 * instead of restarting — and so cost is never lost.
 */
export interface Checkpoint {
  completedSteps: string[];
  /** Accumulated outputs keyed by step name (e.g. the spec, the preview URL). */
  data: Record<string, unknown>;
  /** Wall-clock start, for the sentinel's time cap. */
  startedAt?: string;
}

export interface Job {
  id: string;
  siteId: string | null;
  userId: string | null;
  type: JobType;
  state: JobState;
  checkpoint: Checkpoint;
  input: Record<string, unknown>;
  retries: number;
  costTokens: number;
  costUsd: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  site_id: string | null;
  user_id: string | null;
  type: JobType;
  state: JobState;
  checkpoint: Checkpoint;
  input: Record<string, unknown>;
  retries: number;
  cost_tokens: number | string;
  cost_usd: number | string;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function map(r: JobRow): Job {
  return {
    id: r.id,
    siteId: r.site_id,
    userId: r.user_id,
    type: r.type,
    state: r.state,
    checkpoint: r.checkpoint ?? { completedSteps: [], data: {} },
    input: r.input ?? {},
    retries: Number(r.retries),
    costTokens: Number(r.cost_tokens),
    costUsd: Number(r.cost_usd),
    error: r.error,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function createJob(args: {
  type: JobType;
  input?: Record<string, unknown>;
  userId?: string | null;
  siteId?: string | null;
}): Promise<Job> {
  const db = await getDb();
  const rows = await db.query<JobRow>(
    `INSERT INTO jobs (type, input, user_id, site_id, state, checkpoint)
     VALUES ($1, $2::jsonb, $3, $4, 'queued', $5::jsonb)
     RETURNING *`,
    [
      args.type,
      JSON.stringify(args.input ?? {}),
      args.userId ?? null,
      args.siteId ?? null,
      JSON.stringify({ completedSteps: [], data: {} }),
    ],
  );
  return map(rows[0]!);
}

export async function getJob(id: string): Promise<Job | null> {
  const db = await getDb();
  const rows = await db.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

export async function setState(
  id: string,
  state: JobState,
  error: string | null = null,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE jobs SET state = $2, error = $3, updated_at = now() WHERE id = $1`,
    [id, state, error],
  );
}

/** Persist progress after a completed step (checkpoint + running cost totals). */
export async function saveCheckpoint(
  id: string,
  checkpoint: Checkpoint,
  costUsd: number,
  costTokens: number,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE jobs
       SET checkpoint = $2::jsonb, cost_usd = $3, cost_tokens = $4, updated_at = now()
     WHERE id = $1`,
    [id, JSON.stringify(checkpoint), costUsd, costTokens],
  );
}

/**
 * All site URLs built for a given chat (most recent first, deduped). Powers
 * "send me my site link" from any conversation phase. Reads the URL out of each
 * completed/preview job's checkpoint.
 */
export async function sitesForChat(
  channel: string,
  chatId: string,
): Promise<string[]> {
  const db = await getDb();
  const rows = await db.query<{ checkpoint: Checkpoint }>(
    `SELECT checkpoint FROM jobs
     WHERE input->>'chatId' = $1 AND input->>'channel' = $2
       AND state IN ('completed', 'awaiting_approval')
     ORDER BY created_at DESC
     LIMIT 8`,
    [chatId, channel],
  );
  const urls: string[] = [];
  for (const r of rows) {
    const data = r.checkpoint?.data ?? {};
    const url = (data["deployedUrl"] ?? data["previewUrl"]) as string | undefined;
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls.slice(0, 3);
}

/**
 * The most recently built site for a chat (siteId + url). Used to self-heal the
 * conversation's current site when its siteId was lost — so the bot never claims
 * "you have no site" while completed builds exist.
 */
export async function latestSiteForChat(
  channel: string,
  chatId: string,
): Promise<{ siteId: string; url: string | null } | null> {
  const ids = await recentSiteIdsForChat(channel, chatId, 1);
  return ids[0] ?? null;
}

/**
 * The customer's most recent successfully-built sites (newest first), so the app
 * can pick the first one that still genuinely exists. Only completed/awaiting-
 * approval jobs count, so a failed build never becomes the "current" site.
 */
export async function recentSiteIdsForChat(
  channel: string,
  chatId: string,
  limit = 8,
): Promise<{ siteId: string; url: string | null }[]> {
  const db = await getDb();
  const rows = await db.query<{ input: Record<string, unknown>; checkpoint: Checkpoint }>(
    `SELECT input, checkpoint FROM jobs
     WHERE input->>'chatId' = $1 AND input->>'channel' = $2
       AND state IN ('completed', 'awaiting_approval')
     ORDER BY created_at DESC
     LIMIT $3`,
    [chatId, channel, limit],
  );
  return collectSites(rows);
}

/**
 * Recent sites for a USER across ALL their channels (WhatsApp, web, Telegram) —
 * so logging into the web dashboard/chat sees the site they built by phone. Maps
 * the user's conversations to their build jobs.
 */
export async function recentSiteIdsForUser(
  userId: string,
  limit = 8,
): Promise<{ siteId: string; url: string | null }[]> {
  const db = await getDb();
  const rows = await db.query<{ input: Record<string, unknown>; checkpoint: Checkpoint }>(
    `SELECT j.input, j.checkpoint FROM jobs j
       JOIN intake_conversations c
         ON c.channel = j.input->>'channel' AND c.chat_id = j.input->>'chatId'
      WHERE c.user_id = $1
        AND j.state IN ('completed', 'awaiting_approval')
      ORDER BY j.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return collectSites(rows);
}

/** Extract unique {siteId, url} from a set of job rows, newest first. */
function collectSites(
  rows: { input: Record<string, unknown>; checkpoint: Checkpoint }[],
): { siteId: string; url: string | null }[] {
  const out: { siteId: string; url: string | null }[] = [];
  for (const r of rows) {
    const siteId = r.input?.["siteId"] as string | undefined;
    if (!siteId || out.some((o) => o.siteId === siteId)) continue;
    const data = r.checkpoint?.data ?? {};
    const url = (data["deployedUrl"] ?? data["previewUrl"]) as string | undefined;
    out.push({ siteId, url: url ?? null });
  }
  return out;
}

/**
 * On startup, any job still 'running' or 'queued' was orphaned by the previous
 * process exiting (the in-process queue doesn't survive a restart). Mark them
 * failed so conversations stuck in "building" can self-heal on the next message
 * instead of waiting forever. Returns how many were reconciled.
 */
export async function failOrphanedJobs(): Promise<number> {
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    `UPDATE jobs SET state = 'failed', error = 'interrupted (server restart)', updated_at = now()
     WHERE state IN ('running', 'queued') RETURNING id`,
  );
  return rows.length;
}

/**
 * Atomically claim the oldest queued job and mark it running. Uses
 * FOR UPDATE SKIP LOCKED so multiple workers never grab the same job (matters
 * once this runs on real Postgres with a BullMQ worker pool).
 */
export async function claimNextQueued(): Promise<Job | null> {
  const db = await getDb();
  const rows = await db.query<JobRow>(
    `UPDATE jobs SET state = 'running', updated_at = now()
     WHERE id = (
       SELECT id FROM jobs WHERE state = 'queued'
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
  );
  return rows[0] ? map(rows[0]) : null;
}
