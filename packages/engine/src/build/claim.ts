// Owning a build (ARCH 8.5 "one live build per checkout"; M4 review fixes 1, 2 and 8). start, resume and reset decide
// what to write from the log and the lease, then own the run in one transaction that refuses when another holder in
// the checkout is alive, when the lease table changed, or when a build event came after the decision; then they
// decide again. Also start's look at the previous build (Q3 a): a live one stops it (or, in a terminal, start offers
// to attach to it); a crashed one is superseded.
import type { Engine } from "../api/engine.js";
import type { Said } from "../api/stop.js";
import { buildSeq } from "../log/lease.js";
import type { NewEvent } from "../log/types.js";
import { outcomeOf } from "../stats/status.js";
import { ownerOf } from "./runs.js";

/** build.owner_acquired for this instance. */
export const acquired = (engine: Engine, run: string): NewEvent => {
  const self = engine.deps.processes.self();
  return { type: "build.owner_acquired", run_id: run, actor: "engine",
    data: { instance: self.instance, host: self.host, pid: self.pid } };
};

export type Ready = { readonly events: readonly NewEvent[]; readonly since: number };
export type Claimed<D, T> = { owned: D } | { done: T } | { live: string } | { lost: true };

/** Owns `run` (null: the checks only, for `--detach`) with what the decision says; up to three decisions. */
export async function claimRun<D extends Ready, T>(engine: Engine, run: string | null, first: D | { done: T },
  again: () => Promise<D | { done: T }>): Promise<Claimed<D, T>> {
  let decision = first;
  for (let tries = 1; ; tries++) {
    if ("done" in decision) return decision;
    const owned = await engine.own(run, decision.events, { since: decision.since });
    if (owned.ok) return { owned: decision };
    if (owned.owner) return { live: owned.owner.run_id };
    if (tries === 3) return { lost: true };
    decision = await again();
  }
}

/**
 * `rafi stop` on a waiting or paused build with no live owner (M4 review fix 8): stop's events, written owning nothing
 * (`engine.own(null)`), so the write is refused when a holder in the checkout is alive or a build event came after the
 * decision (`since`); a `rafi resume` that took the build over meanwhile then gets a stop request, not a stopped
 * build under it. Null: decide again.
 */
export async function stopUnowned(engine: Engine, run: string, events: readonly NewEvent[], since: number):
  Promise<Said | null> {
  const owned = await engine.own(null, events, { since });
  if (owned.ok) return { code: 0, line: `Build ${run} stopped. \`rafi resume\` continues it.` };
  if (owned.owner && owned.owner.run_id !== run) {
    return { code: 1, line: `Build ${owned.owner.run_id} is running here (one live build per checkout); build ${run} ` +
      "was left as it is." };
  }
  return null;
}

/**
 * `rafi stop`'s request to a live owner (M4 review fix 9): written unless a build event came after the decision
 * (`since`, checked in the write transaction), as when the owner released or finished the build meanwhile; false then.
 */
export async function writeSince(engine: Engine, events: readonly NewEvent[], since: number): Promise<boolean> {
  const changed = new Error("the build changed after rafi decided");
  try {
    await engine.append(events, { inTx: (db) => { if (buildSeq(db) !== since) throw changed; } });
    return true;
  } catch (error) {
    if (error === changed) return false;
    throw error;
  }
}

export type Fresh = Ready & { readonly line: string | null };
export type Previous = { live: string } | Fresh;

/**
 * Q3 (a): a live build stops `rafi start`; an unfinished build nothing runs doesn't. The new build redoes its
 * interrupted step first (the fold's tickets are the project's), a crashed one gets its build.owner_lost, and the
 * old one shows as superseded (`line`, said once the new build owns the checkout).
 */
export async function previousBuild(engine: Engine): Promise<Previous> {
  const since = engine.buildSeq();
  const view = engine.fold();
  const old = view.run ? view.builds[view.run] : undefined;
  if (!old) return { events: [], line: null, since };
  const owner = await ownerOf(engine, old);
  if (owner === "alive" || owner === "not-responding") return { live: old.run };
  const all = [];
  for await (const e of engine.events({ run: old.run })) all.push(e);
  const outcome = await outcomeOf(engine, view, old, all);
  if (!outcome.resumable) return { events: [], line: null, since };
  return { since, line: `Build ${old.run} was left ${outcome.text}; this build does its interrupted work first, and ` +
    `${old.run} is shown as superseded.`, events: outcome.kind !== "crashed" || old.state === "stopped" ? []
    : [{ type: "build.owner_lost", run_id: old.run, actor: "engine", data: { last_heartbeat_at:
      engine.lease(old.run)?.heartbeat_at ?? engine.deps.clock.now().toISOString() } }] };
}

/** Start's terminal: asks whether to attach to the live build; its exit code once attached, null when declined. */
export interface AttachUI {
  line(text: string): void;
  offerAttach?(run: string, question: string): Promise<number | null>;
}

/** ARCH 8.5: a live build here stops `rafi start`; in a terminal it offers to attach instead (C178). */
export async function liveBuild(run: string, tty: boolean, ui: AttachUI): Promise<number> {
  if (!tty || !ui.offerAttach) {
    ui.line(`Build ${run} is already running here; follow it with \`rafi resume\` (one live build per checkout).`);
    return 1;
  }
  const code = await ui.offerAttach(run, `Build ${run} is already running here (one live build per checkout). ` +
    "Attach to it?");
  if (code === null) ui.line("Nothing was started.");
  return code ?? 0;
}
