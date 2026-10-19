import type { TicketDef } from "./tickets/ticketSchema.js";

/** Full authoritative definition, shared by initial/resumed/remediation paths. */
export function renderBuildWorkContext(ticket: TicketDef, checklist: readonly string[]): string {
  return ["Full assigned work definition (scope authority):", JSON.stringify(ticket, null, 2),
    "Project validation checklist:", ...(checklist.length ? checklist.map((item, index) => `${index + 1}. ${item}`) : ["No additional project checklist configured."]),
    "Implement this assigned work and provide verification evidence. Explicitly map every acceptance item to a concrete result or truthful limitation in the final report. If the delivered QA contract requires a historical sequence (for example, a test-first red phase before an implementation edit), execute that sequence in order and retain bounded, truthful evidence of each required step in your final response, including the relevant command result and an ordering record. Do not claim a later passing test proves an earlier failing step. Final QA runs independently in a separate disposable snapshot and fresh reviewer conversation."].join("\n");
}
