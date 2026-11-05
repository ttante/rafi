// Creation groups (FMT-S5, FLAG-TK-8; M5 plan item 11, C232): `ticket.group_created` names a group `TG-<n>` and keeps
// each member's definition as a blob, so a reset can restore a ticket deleted from tickets.yaml. `groups list` reads
// them back; `groups repair` puts every ticket outside a group into one new group (PRM-59 asks first in the CLI).
import type { TicketV1 } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import type { NewEvent } from "../log/types.js";
import { eventsOf } from "./inbox.js";
import { loadTickets } from "./load.js";
import { ACTORS, type TicketWrite } from "./status.js";

type Who = { actor: string; source: "terminal" | "flag" };

export interface Group {
  readonly id: string;
  readonly at: string;
  readonly origin: string;
  readonly members: readonly { ticket: string; definition: string }[];
}

export async function groups(engine: Engine): Promise<Group[]> {
  return (await eventsOf(engine, ["ticket.group_created"])).map((e) => {
    const d = e.data as { group: string; origin: string; members: Group["members"] };
    return { id: d.group, at: e.at, origin: d.origin, members: d.members };
  });
}

/** The group event for these definitions: the next `TG-<n>`, each member's definition stored as a blob. */
export async function groupEvent(engine: Engine, tickets: readonly Record<string, unknown>[], origin: string,
  o: Who): Promise<NewEvent> {
  const group = `TG-${(await groups(engine)).length + 1}`;
  const members = [];
  for (const t of tickets) members.push({ ticket: String(t.id), definition: await engine.blob(JSON.stringify(t)) });
  return { type: "ticket.group_created", actor: o.actor, source: o.source, data: { group, origin,
    tickets: members.map((m) => m.ticket), members } };
}

/** A member's definition as the group stored it, or null when the blob is gone. */
export function memberDefinition(engine: Engine, m: Group["members"][number]): TicketV1 | null {
  const text = engine.readBlob(m.definition);
  return text === null ? null : JSON.parse(text) as TicketV1;
}

/** The tickets in tickets.yaml that no group holds. */
export async function ungrouped(engine: Engine): Promise<TicketV1[] | string> {
  const loaded = await loadTickets(engine.deps.fs, engine.projectDir);
  if (!loaded.ok) return loaded.message;
  const grouped = new Set((await groups(engine)).flatMap((g) => g.members.map((m) => m.ticket)));
  return loaded.tickets.filter((t) => !grouped.has(t.id));
}

/** `rafi tickets groups repair`: one group for exactly the tickets outside any group. */
export async function repairGroups(engine: Engine, expected: number, o: Who): Promise<TicketWrite> {
  if (!ACTORS.includes(o.actor)) return { ok: false, message: `--actor takes ${ACTORS.join(", ")}.` };
  const outside = await ungrouped(engine);
  if (typeof outside === "string") return { ok: false, message: outside };
  if (!outside.length) return { ok: true, line: "Every ticket is already in a group." };
  if (outside.length !== expected) return { ok: false, message: "The tickets outside a group changed while rafi " +
    "asked; run it again." };
  const event = await groupEvent(engine, outside as unknown as Record<string, unknown>[], "repair", o);
  await engine.append([event]);
  return { ok: true, line: `${String((event.data as { group: string }).group)} holds ${outside.map((t) => t.id)
    .join(", ")}.` };
}
