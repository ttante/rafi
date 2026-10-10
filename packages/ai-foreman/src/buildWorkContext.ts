import type { TicketDef } from "./tickets/ticketSchema.js";

/** Full authoritative definition, shared by initial/resumed/remediation paths. */
export function renderBuildWorkContext(ticket: TicketDef, checklist: readonly string[]): string {
  return ["Full assigned work definition (scope authority):", JSON.stringify(ticket, null, 2),
    "Project validation checklist:", ...(checklist.length ? checklist.map((item, index) => `${index + 1}. ${item}`) : ["No additional project checklist configured."]),
    "Implement this assigned work and provide verification evidence. Final QA runs independently in a separate disposable snapshot and fresh reviewer conversation."].join("\n");
}
