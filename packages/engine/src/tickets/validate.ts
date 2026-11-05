// `rafi tickets validate` and `rafi tickets queue` (FLAG-TK-20, FLAG-TK-21; M5 plan item 28). The four passes, as
// today's `validate.ts`: 1. the files (schema, dependencies known and acyclic, delivery units naming known tickets);
// 2. the log against them (the fold's violations, a status for an unknown ticket); 3. the queue (every open ticket
// listed once, in order); 4. the progress doc, when the tracker keeps one (it exists and has `Next up`).
import type { Engine } from "../api/engine.js";
import type { Folded } from "../state/types.js";
import { loadTickets } from "./load.js";
import { progressDocPath } from "./render.js";
import { riskGaps } from "./risk.js";

export const VALIDATION_PASSED = "validation passed — all 4 passes clean";

function cycle(deps: ReadonlyMap<string, readonly string[]>): string | null {
  const state = new Map<string, "open" | "done">();
  const visit = (id: string, path: string[]): string | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "open") return [...path, id].join(" → ");
    state.set(id, "open");
    for (const d of deps.get(id) ?? []) { const found = visit(d, [...path, id]); if (found) return found; }
    state.set(id, "done");
    return null;
  };
  for (const id of deps.keys()) { const found = visit(id, []); if (found) return found; }
  return null;
}

export async function validateTickets(engine: Engine, docsRoot: string): Promise<string[]> {
  const loaded = await loadTickets(engine.deps.fs, engine.projectDir);
  if (!loaded.ok) return [`[pass 1] ${loaded.message}`];
  const problems: string[] = [];
  const ids = new Set(loaded.tickets.map((t) => t.id));
  for (const t of loaded.tickets) {
    for (const d of t.depends_on) {
      if (!ids.has(d)) problems.push(`[pass 1] ${t.id} depends on ${d}, which isn't a ticket`);
    }
  }
  const loop = cycle(new Map(loaded.tickets.map((t) => [t.id, t.depends_on])));
  if (loop) problems.push(`[pass 1] dependency cycle: ${loop}`);
  for (const u of loaded.units) {
    for (const t of u.tickets) {
      if (!ids.has(t)) problems.push(`[pass 1] delivery unit ${u.id} names ${t}, which isn't a ticket`);
    }
  }
  const view = engine.fold(loaded.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
  for (const v of view.violations) problems.push(`[pass 2] event ${v.seq}: ${v.reason}`);
  for (const id of Object.keys(view.tickets)) {
    if (!ids.has(id) && !view.tickets[id]!.rafiOwned) problems.push(`[pass 2] the log has a status for ${id}, which ` +
      "isn't in .tickets/tickets.yaml");
  }
  const gaps = await riskGaps(engine, loaded.tickets);
  for (const g of typeof gaps === "string" ? [] : gaps.filter((x) => !x.waived)) {
    problems.push(`[pass 2] ${g.id} is ${g.risk} risk with no rollback plan or waiver; add \`rollback:\` or run ` +
      "rafi tickets waive-risk-notes");
  }
  const rows = queueRows(view);
  if (new Set(rows.map((r) => r.id)).size !== rows.length) problems.push("[pass 3] a ticket is listed twice");
  const doc = await progressDocPath(engine, docsRoot);
  if (doc && !(await engine.deps.fs.stat(doc.file))) problems.push("[pass 4] the progress doc is missing; run rafi " +
    "tickets render");
  else if (doc && !/^## Next up$/m.test(await engine.deps.fs.read(doc.file))) {
    problems.push("[pass 4] the progress doc has no Next up section; run rafi tickets render");
  }
  return problems;
}

/** The queue: open tickets in queue order, rafi-owned fix tickets first (ARCH 4.5 rule 6). */
export function queueRows(view: Folded): { id: string; status: string; waits: string[] }[] {
  const open = (id: string) => !["done", "dropped"].includes(view.tickets[id]?.state ?? "queued");
  const owned = Object.values(view.tickets).filter((t) => t.rafiOwned && open(t.id)).map((t) => t.id);
  const listed = view.queue.map((d) => d.id).filter((id) => open(id) && !owned.includes(id));
  return [...owned, ...listed].map((id) => ({ id, status: view.tickets[id]?.state ?? "queued",
    waits: (view.queue.find((d) => d.id === id)?.dependsOn ?? []).filter((d) => view.tickets[d]?.state !== "done") }));
}
