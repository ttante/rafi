// Which build: the ticket definitions, the runs in start order, a run by a unique id prefix, and its owner's
// liveness (the lease, C133, plus whether the owner released it). Shared by resume, stop, reset, status and start.
import type { Engine } from "../api/engine.js";
import type { OwnerLiveness } from "../state/labels.js";
import type { BuildState, Folded, TicketDefinition } from "../state/types.js";
import { loadTickets } from "../tickets/load.js";

export async function definitions(engine: Engine): Promise<TicketDefinition[]> {
  const loaded = await loadTickets(engine.deps.fs, engine.projectDir);
  return loaded.ok ? loaded.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })) : [];
}

/** Runs in start order (newest last). */
export function runIds(view: Folded): string[] {
  return Object.keys(view.builds).filter((r) => view.builds[r]!.state !== "none");
}

/** A run by a unique prefix of its id. */
export function findRun(view: Folded, prefix: string): { run: string } | { message: string } {
  const matches = runIds(view).filter((r) => r.startsWith(prefix));
  if (matches.length === 1) return { run: matches[0]! };
  if (!matches.length) return { message: `There's no build ${prefix} here.` };
  return { message: `${prefix} matches more than one build (${matches.join(", ")}); give more of its id.` };
}

/** `rafi stop` and pause: the build `run` names (a prefix), else the latest; a message when there's none. */
export async function pickBuild(engine: Engine, run: string | undefined) {
  const view = engine.fold(await definitions(engine));
  const picked = run ? findRun(view, run) : view.run ? { run: view.run } : null;
  if (!picked) return { view, message: "No build is running here.", code: 0 };
  if ("message" in picked) return { view, message: picked.message, code: 1 };
  return { view, build: view.builds[picked.run]! };
}

/** The owner's liveness for a build: the lease (C133) plus whether the owner released it (the fold). */
export async function ownerOf(engine: Engine, build: BuildState): Promise<OwnerLiveness> {
  const lease = await engine.liveness(build.run);
  if (lease !== "none") return lease;
  return build.ownerReleased ? "released" : "none";
}
