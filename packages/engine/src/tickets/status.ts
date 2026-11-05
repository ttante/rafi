// `rafi tickets update/complete/block/unblock/cancel` on the log (FLAG-TK-10–14; ARCH 4.2; M5 plan C208, C209).
// Each is one event with its actor and source and changes no other field. The fold refuses a status change on the
// ticket a live build is working on, inside the append's transaction (R1), and the refusal is one line.
import type { Engine } from "../api/engine.js";
import { InvalidEventError } from "../log/append.js";
import type { NewEvent } from "../log/types.js";
import { pruneInterviews } from "../setup/interviews.js";
import { loadTickets } from "./load.js";

export const ACTORS: readonly string[] = ["user", "manager", "api"];
export type TicketWrite = { ok: true; line: string } | { ok: false; message: string };

export interface StatusChange {
  readonly status: "planned" | "next" | "in_progress" | "blocked" | "done" | "canceled";
  readonly summary?: string | null;
  readonly validation?: string | null;
  readonly evidence?: string | null;
}

async function write(engine: Engine, id: string, event: Omit<NewEvent, "ticket_id" | "actor" | "source">,
  o: { actor: string; source: "terminal" | "flag" }): Promise<TicketWrite | null> {
  if (!ACTORS.includes(o.actor)) return { ok: false, message: `--actor takes ${ACTORS.join(", ")}.` };
  await pruneInterviews(engine.deps.fs, engine.projectDir, engine.deps.clock.now());
  const loaded = await loadTickets(engine.deps.fs, engine.projectDir);
  if (!loaded.ok) return loaded;
  if (!loaded.tickets.some((t) => t.id === id)) return { ok: false, message: `There's no ticket ${id}.` };
  try {
    await engine.append([{ ...event, ticket_id: id, actor: o.actor, source: o.source }]);
    return null;
  } catch (error) {
    if (error instanceof InvalidEventError) {
      return { ok: false, message: error.message.split("\n")[0]!.replace(/^invalid transition: /, "") };
    }
    throw error;
  }
}

export async function setTicketStatus(engine: Engine, id: string, change: StatusChange,
  o: { actor: string; source: "terminal" | "flag" }): Promise<TicketWrite> {
  const by = o.actor === "manager" ? "manager" : o.actor === "api" ? "api" : "user";
  const failed = await write(engine, id, { type: "ticket.status_set", data: { status: change.status,
    summary: change.summary ?? null, validation: change.validation ?? null, evidence: change.evidence ?? null, by } },
  o);
  return failed ?? { ok: true, line: `${id}: ${change.status}.` };
}

export async function cancelTicket(engine: Engine, id: string, summary: string,
  o: { actor: string; source: "terminal" | "flag" }): Promise<TicketWrite> {
  const failed = await write(engine, id, { type: "ticket.dropped", data: { why: "canceled" } }, o);
  return failed ?? { ok: true, line: `${id}: canceled (${summary}).` };
}
