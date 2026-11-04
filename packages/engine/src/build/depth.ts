// QA preparation depth (ARCH 6.3, 13; REQ Q-REQ-1, FMT-T11; C113): the planner's choice, raised to rafi's minimum
// for the ticket's risk. The minimums are one frozen map (P23 (a), option i, decided by the user).

export const DEPTHS: readonly string[] = Object.freeze(["focused", "standard", "extensive", "critical", "exceptional"]);

export const MINIMUMS: Readonly<Record<"Low" | "Medium" | "High", string>> = Object.freeze({
  Low: "standard", Medium: "standard", High: "extensive",
});

/** `raisedFrom` is the planner's depth (absent means `standard`) when rafi raised it, else null. */
export function depthFor(ticket: { risk: "Low" | "Medium" | "High"; qa_preparation?: { depth: string } }):
  { depth: string; raisedFrom: string | null } {
  const given = ticket.qa_preparation?.depth ?? "standard";
  const minimum = MINIMUMS[ticket.risk];
  return DEPTHS.indexOf(given) < DEPTHS.indexOf(minimum) ? { depth: minimum, raisedFrom: given }
    : { depth: given, raisedFrom: null };
}
