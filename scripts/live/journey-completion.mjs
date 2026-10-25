import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(new URL("../../packages/ai-foreman/package.json", import.meta.url));
const Database = require("better-sqlite3");

/** Read-only release evidence: a consumed certificate alone is insufficient. */
export function completedJourneyTickets(project) {
  const db = new Database(join(project, ".rafi/recovery.sqlite3"), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT DISTINCT c.ticket_id AS ticketId, c.run_id AS runId, c.certificate_id AS certificateId
      FROM qa_pass_certificates c
      JOIN qa_finalization_steps f ON f.certificate_id=c.certificate_id AND f.run_id=c.run_id AND f.ticket_id=c.ticket_id
      WHERE c.consumed_at IS NOT NULL AND c.consumed_by='ticket-complete:'||c.ticket_id
      AND f.kind='ticket-complete:'||c.ticket_id AND f.status='completed'
      ORDER BY c.ticket_id`).all();
  } finally { db.close(); }
}
