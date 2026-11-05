// `rafi tickets reset` (FLAG-TK-9; Q-CMD-3 e; PRM-57, PRM-58; M5 plan C232, R8): the tracker-only reset. Each ticket
// it selects goes back to `planned` with one `ticket.status_set` (history and validation stay in the log, so `show`
// still reads them). Targets: one ticket, a `--scope`, or creation groups (`--group`, `--group-index`,
// `--recent-groups`, `--all-groups`); a group member deleted from tickets.yaml is left out, or with
// `--deleted-tickets restore` its stored definition goes back through the definitions writer. The preview says when
// tickets belong to an interrupted build (PRM-58 points to `rafi reset` for that) and refuses while a build is live.
// R8: the write happens only if no build event came after the preview (`own(null, …, { since })`), so a `rafi
// resume` that takes the build in between makes the reset refuse instead of racing it.
import type { TicketV1 } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import { previousBuild } from "../build/claim.js";
import { boundary } from "../deps/hooks.js";
import type { NewEvent } from "../log/types.js";
import { ticketMaps, writeDefinitions } from "./edit.js";
import { groups, memberDefinition } from "./groups.js";
import { loadTickets } from "./load.js";
import { ACTORS, type TicketWrite } from "./status.js";

type Who = { actor: string; source: "terminal" | "flag" };
export const RESET_SCOPES: readonly string[] = ["all", "completed-and-unfinished", "unfinished"];

export interface ResetTarget {
  readonly ticket?: string;
  readonly scope?: string;
  readonly group?: string;
  readonly groupIndex?: number;
  readonly recentGroups?: number;
  readonly allGroups?: boolean;
}

export interface ResetPreview {
  readonly tickets: readonly { id: string; title: string; status: string }[];
  /** Group members no longer in tickets.yaml, with the definitions the groups stored. */
  readonly missing: readonly TicketV1[];
  readonly grouped: boolean;
  /** The interrupted build whose tickets these are (PRM-58), or null. */
  readonly interrupted: { run: string; tickets: string[] } | null;
  readonly live: string | null;
  readonly since: number;
}

const TRACKER: Readonly<Record<string, string>> = Object.freeze({ queued: "planned", building: "in_progress",
  reviewing: "in_progress", fixing: "in_progress", blocked: "blocked", done: "done", dropped: "canceled" });
const ACTIVE: readonly string[] = ["building", "reviewing", "fixing"];

async function groupTargets(engine: Engine, t: ResetTarget): Promise<string[] | { message: string }> {
  const all = await groups(engine);
  let chosen = all;
  if (t.group) chosen = all.filter((g) => g.id === t.group);
  else if (t.groupIndex !== undefined) chosen = all.slice(t.groupIndex - 1, t.groupIndex);
  else if (t.recentGroups !== undefined) chosen = all.slice(-t.recentGroups);
  if (!chosen.length) return { message: `There's no creation group ${t.group ?? `#${t.groupIndex ?? ""}`}. ` +
    "`rafi tickets groups list` lists them." };
  return [...new Set(chosen.flatMap((g) => g.members.map((m) => m.ticket)))];
}

/** What a reset would change, and why it might not (PRM-57, PRM-58). */
export async function previewReset(engine: Engine, t: ResetTarget): Promise<ResetPreview | { message: string }> {
  const since = engine.buildSeq();
  const loaded = await loadTickets(engine.deps.fs, engine.projectDir);
  if (!loaded.ok) return loaded;
  const view = engine.fold(loaded.tickets.map((x) => ({ id: x.id, dependsOn: x.depends_on })));
  const status = (id: string) => TRACKER[view.tickets[id]?.state ?? "queued"] ?? "planned";
  const grouped = Boolean(t.group || t.groupIndex !== undefined || t.recentGroups !== undefined || t.allGroups);
  let ids: string[];
  let missing: TicketV1[] = [];
  if (grouped) {
    const members = await groupTargets(engine, t);
    if ("message" in members) return members;
    ids = members.filter((id) => loaded.tickets.some((x) => x.id === id));
    const stored = (await groups(engine)).flatMap((g) => g.members);
    missing = members.filter((id) => !ids.includes(id)).map((id) => memberDefinition(engine,
      [...stored].reverse().find((m) => m.ticket === id)!)).filter((d): d is TicketV1 => d !== null);
  } else if (t.ticket) {
    if (!loaded.tickets.some((x) => x.id === t.ticket)) return { message: `There's no ticket ${t.ticket}.` };
    ids = [t.ticket];
  } else if (t.scope && RESET_SCOPES.includes(t.scope)) {
    const skip = t.scope === "all" ? [] : t.scope === "unfinished" ? ["done", "canceled"] : ["canceled"];
    ids = loaded.tickets.map((x) => x.id).filter((id) => !skip.includes(status(id)));
  } else {
    return { message: `--scope takes ${RESET_SCOPES.join(", ")}.` };
  }
  const previous = await previousBuild(engine);
  const live = "live" in previous ? previous.live : null;
  const active = ids.filter((id) => ACTIVE.includes(view.tickets[id]?.state ?? ""));
  const interrupted = !live && view.run && active.length ? { run: view.run, tickets: active } : null;
  return { since, live, interrupted, grouped, missing,
    tickets: ids.map((id) => ({ id, title: loaded.tickets.find((x) => x.id === id)?.title ?? "",
      status: status(id) })) };
}

/** Applies a previewed reset; refused when a build event came after the preview (R8). */
export async function applyReset(engine: Engine, p: ResetPreview, o: Who & { restore: boolean }):
  Promise<TicketWrite> {
  if (!ACTORS.includes(o.actor)) return { ok: false, message: `--actor takes ${ACTORS.join(", ")}.` };
  if (p.live) return { ok: false, message: `Build ${p.live} is running; stop it first (\`rafi stop\`).` };
  const restored = o.restore ? p.missing : [];
  if (restored.length) {
    const wrote = await writeDefinitions(engine, (doc) => {
      const list = doc.get("tickets") as { items: unknown[] };
      for (const def of restored) {
        if (ticketMaps(doc).some((x) => x.get("id") === def.id)) continue;
        list.items.push(doc.createNode(def));
      }
      return { ok: true, line: "", items: restored.map((d) => ({ ticket: d.id, field: "added" })) };
    }, o);
    if (!wrote.ok) return wrote;
  }
  const by = o.actor === "manager" ? "manager" : o.actor === "api" ? "api" : "user";
  const ids = [...p.tickets.map((t) => t.id), ...restored.map((d) => d.id)];
  const events: NewEvent[] = ids.map((id) => ({ type: "ticket.status_set", ticket_id: id, actor: o.actor,
    source: o.source, data: { status: "planned", summary: "Reset with rafi tickets reset", validation: null,
      evidence: null, by } }));
  await boundary(engine.deps.hooks, "7: before the tickets reset is recorded");
  const written = await engine.own(null, events, { since: p.since });
  if (!written.ok) {
    return { ok: false, message: "A build started or resumed while rafi was resetting these tickets; nothing " +
      "was reset. Run `rafi tickets reset` again once it's stopped (`rafi stop`)." };
  }
  return { ok: true, line: `Reset ${ids.length} ticket(s)${restored.length ? ` (restored ${restored.map((d) => d.id)
    .join(", ")})` : ""}. Their history and validation stay in \`rafi tickets show\`.` };
}
