// R3 and R4 (M5 plan 3.4): a scope, and the approval PRM-71 asked for it, stand only for the ticket files they were
// chosen from. The log's write transaction is synchronous and file reads aren't, so the files can't be compared
// inside `build.started`'s transaction (plan 10.4); instead start reads them again right before it writes, and when
// their digests (P41) differ it chooses the scope again from the new files (asking again where it asked), at most
// three times. An edit after that last read is an ordinary outside edit: the loop's first re-read, before any ticket
// starts, records it once and applies it (C211).
import type { Settings } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import type { Prepared, RunUI } from "../build/run.js";
import { chooseScope, type Chosen, type ScopeFlags, type ScopeUI } from "../build/scope.js";
import { loadTickets, sameDigests } from "../tickets/load.js";

export async function freshScope(engine: Engine, o: ScopeFlags & { tty: boolean; autoApprove?: boolean },
  first: Prepared, settings: Settings, ui: RunUI & ScopeUI, run: string):
  Promise<number | { chosen: Chosen; prepared: Prepared }> {
  let prepared = first;
  for (let tries = 1; ; tries += 1) {
    const chosen = await chooseScope(engine, o, prepared, settings, ui, run);
    if (typeof chosen === "number") return chosen;
    const now = await loadTickets(engine.deps.fs, engine.projectDir);
    if (!now.ok || tries === 3 || sameDigests(now, prepared.tickets)) return { chosen, prepared };
    ui.line(".tickets/ changed while rafi was choosing the scope; choosing it again from the new files.");
    prepared = { ...prepared, tickets: now };
  }
}
