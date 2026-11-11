import { getDb } from "../db/index.js";

/**
 * A durable backlog of domains customers have asked us to secure, so the founder
 * can fulfil them the moment the registrar (Namesilo reseller) is live — and so
 * a request is never lost between chats. Uses the existing `domains` table.
 */
export async function recordDomainRequest(
  userId: string,
  name: string,
): Promise<void> {
  const db = await getDb();
  // Don't pile up duplicates for the same customer + name still outstanding.
  await db.query(
    `INSERT INTO domains (user_id, name, status)
     SELECT $1, $2, 'requested'
     WHERE NOT EXISTS (
       SELECT 1 FROM domains
       WHERE user_id = $1 AND name = $2 AND status IN ('requested','pending')
     )`,
    [userId, name.toLowerCase()],
  );
}
