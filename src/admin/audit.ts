import { getDb } from "../db/index.js";

/**
 * Audit trail for admin actions — who did what, to whom, when. Every state
 * change in the control centre is recorded, so with a team you can always answer
 * "who suspended that site?" or "who granted those credits?".
 */

export interface AuditEntry {
  id: string;
  actor: string | null;
  action: string;
  target: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

interface Row {
  id: string;
  actor: string | null;
  action: string;
  target: string | null;
  meta: Record<string, unknown>;
  created_at: string | Date;
}

export async function audit(
  actor: string,
  action: string,
  target: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO audit_logs (actor, action, target, meta) VALUES ($1, $2, $3, $4::jsonb)`,
    [actor, action, target, JSON.stringify(meta)],
  );
}

export async function recentAudit(limit = 100): Promise<AuditEntry[]> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    action: r.action,
    target: r.target,
    meta: r.meta ?? {},
    createdAt: String(r.created_at),
  }));
}
