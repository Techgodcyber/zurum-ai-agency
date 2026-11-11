import { getDb } from "../db/index.js";
import type { ModelMessage } from "../models/index.js";

export type ConversationPhase =
  | "intake"
  | "building"
  | "awaiting_approval"
  | "done";

export interface Conversation {
  id: string;
  channel: string;
  chatId: string;
  phase: ConversationPhase;
  jobId: string | null;
  /** Stable site id — the preview URL is /p/<siteId>, updated in place by edits. */
  siteId: string | null;
  /** A reference URL awaiting the customer's "is this your site?" answer. */
  pendingUrl: string | null;
  /** A domain the customer asked us to secure (registration isn't live yet). */
  pendingDomain: string | null;
  /** Waiting for the customer to type a custom top-up amount. */
  awaitingTopup: boolean;
  /** The verified customer this conversation belongs to. */
  userId: string | null;
  messages: ModelMessage[];
}

interface Row {
  id: string;
  channel: string;
  chat_id: string;
  phase: ConversationPhase;
  job_id: string | null;
  site_id: string | null;
  pending_url: string | null;
  pending_domain: string | null;
  awaiting_topup: boolean | null;
  user_id: string | null;
  messages: ModelMessage[];
}

const map = (r: Row): Conversation => ({
  id: r.id,
  channel: r.channel,
  chatId: r.chat_id,
  phase: r.phase,
  jobId: r.job_id,
  siteId: r.site_id,
  pendingUrl: r.pending_url,
  pendingDomain: r.pending_domain,
  awaitingTopup: r.awaiting_topup ?? false,
  userId: r.user_id,
  messages: r.messages ?? [],
});

/** Bind the conversation to its resolved customer (first contact). */
export async function setUser(id: string, userId: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE intake_conversations SET user_id = $2, updated_at = now() WHERE id = $1`,
    [id, userId],
  );
}

/** Remember (or clear) a reference URL while we ask who owns it. */
export async function setPendingUrl(
  id: string,
  url: string | null,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE intake_conversations SET pending_url = $2, updated_at = now() WHERE id = $1`,
    [id, url],
  );
}

/** Flag (or clear) that we're waiting for a custom top-up amount. */
export async function setAwaitingTopup(id: string, val: boolean): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE intake_conversations SET awaiting_topup = $2, updated_at = now() WHERE id = $1`,
    [id, val],
  );
}

/** Remember (or clear) a domain the customer asked us to secure. */
export async function setPendingDomain(
  id: string,
  domain: string | null,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE intake_conversations SET pending_domain = $2, updated_at = now() WHERE id = $1`,
    [id, domain],
  );
}

/** Set the conversation's stable site id (once, when the first build starts). */
export async function setSite(id: string, siteId: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE intake_conversations SET site_id = $2, updated_at = now() WHERE id = $1`,
    [id, siteId],
  );
}

/** Fetch the conversation for a chat, creating it on first contact. */
export async function getOrCreate(
  channel: string,
  chatId: string,
): Promise<Conversation> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `INSERT INTO intake_conversations (channel, chat_id)
     VALUES ($1, $2)
     ON CONFLICT (channel, chat_id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [channel, chatId],
  );
  return map(rows[0]!);
}

/** Append a turn to the stored history. */
export async function appendMessage(
  id: string,
  role: ModelMessage["role"],
  content: string,
): Promise<void> {
  // Never store an empty turn: providers reject histories containing an empty
  // assistant/user message, which would break every later call on this chat.
  if (!content?.trim()) return;
  const db = await getDb();
  await db.query(
    `UPDATE intake_conversations
       SET messages = messages || $2::jsonb, updated_at = now()
     WHERE id = $1`,
    [id, JSON.stringify([{ role, content }])],
  );
}

/** Move the conversation to a new phase, optionally linking its build job. */
export async function setPhase(
  id: string,
  phase: ConversationPhase,
  jobId?: string,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE intake_conversations
       SET phase = $2, job_id = COALESCE($3, job_id), updated_at = now()
     WHERE id = $1`,
    [id, phase, jobId ?? null],
  );
}

/** Find the conversation that owns a site (used to notify on form submissions). */
export async function bySite(siteId: string): Promise<Conversation | null> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `SELECT * FROM intake_conversations WHERE site_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [siteId],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Find the conversation linked to a given job (used by Maestro notifications). */
export async function byJob(jobId: string): Promise<Conversation | null> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `SELECT * FROM intake_conversations WHERE job_id = $1 LIMIT 1`,
    [jobId],
  );
  return rows[0] ? map(rows[0]) : null;
}
