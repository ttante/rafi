import { WorkflowDb } from "./workflowDb.js";
import { buildScopeRevision } from "./buildApproval.js";
import { loadTicketsConfig, resolveTicketPaths } from "./tickets/config.js";
import { loadTickets } from "./tickets/ticketLoader.js";
import { qaDigest } from "./qaProtocolV2.js";

/** Called by the CLI only after its source-bound approval gate succeeds. */
export function admitApprovedTicket(projectDir: string, runId: string, ticketId: string, approvedRevision: string, authorization: string): void {
  const ticket = loadTickets(resolveTicketPaths(loadTicketsConfig(projectDir), projectDir).tickets).find(ticket => ticket.id === ticketId);
  if (!ticket || buildScopeRevision(projectDir) !== approvedRevision) throw new Error("Ticket requirements changed after approval; reselect and approve current work");
  const db = new WorkflowDb(projectDir);
  try {
    db.atomic(() => {
      const current = loadTickets(resolveTicketPaths(loadTicketsConfig(projectDir), projectDir).tickets).find(ticket => ticket.id === ticketId);
      if (!current || buildScopeRevision(projectDir) !== approvedRevision || JSON.stringify(current)!==JSON.stringify(ticket)) throw new Error("Ticket eligibility or requirements changed during admission; reselect approved work");
      db.admitWork({runId, kind:"ticket", ticketId, definition:ticket, approvalId:qaDigest("build-work-approval", {runId, approvedRevision, authorization}), scopeRevision:approvedRevision, provenance:{userTurn:authorization,reason:"CLI source-bound build approval gate succeeded"}});
    });
  } finally { db.close(); }
}
