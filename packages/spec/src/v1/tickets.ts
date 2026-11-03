// M1 part of the 1.0 ticket schema: the reserved `workflow` field (ARCH 4.8, FMT-T21).
// The rest of the ticket schema comes with the ticket port in M2.
import { CUSTOM_WORKFLOWS_MESSAGE } from "./config.js";

export type TicketFieldCheck = { ok: true } | { ok: false; ticket: string; message: string };

export function checkReservedTicketFields(tickets: readonly unknown[]): TicketFieldCheck {
  for (const ticket of tickets) {
    if (ticket && typeof ticket === "object" && "workflow" in ticket) {
      const name = String((ticket as { id?: unknown }).id ?? "?");
      return { ok: false, ticket: name, message: CUSTOM_WORKFLOWS_MESSAGE };
    }
  }
  return { ok: true };
}
