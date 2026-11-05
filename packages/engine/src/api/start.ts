// engine.start (ARCH 8.3): settings in layers with their sources, the tickets, the checks before any agent turn
// (a first commit, the test sandbox or the no-sandbox decision, C60), the agent per role (C34), build.started with
// the pinned workflow, then the loop. Returns the exit code; every user-facing line goes through `ui`.
import { settingsFor, type Flags } from "../config/load.js";
import { runLoop } from "../build/loop.js";
import type { ScopeFlags, ScopeUI } from "../build/scope.js";
import { detachBuild } from "../build/detach.js";
import { contextFor, prepareRun, type RunUI } from "../build/run.js";
import { freshScope } from "../plan/fresh.js";
import { adoptProject } from "../tickets/adopt.js";
import type { DirtyFlag } from "../git/ready.js";
import { standard } from "../workflow/standard.js";
import { workflowDigest } from "../workflow/load.js";
import type { Engine } from "./engine.js";
import type { NewEvent } from "../log/types.js";
import { pruneInterviews } from "../setup/interviews.js";
import {
  acquired, claimRun, liveBuild, previousBuild, type AttachUI, type Fresh, type Previous,
} from "../build/claim.js";

import { ENGINE_VERSION } from "../version.js";
export { ENGINE_VERSION };

export interface StartOptions extends Flags, ScopeFlags, DirtyFlag {
  readonly argv: readonly string[];
  readonly tty: boolean;
  /** `--detach` (ARCH 8.7): the build runs in one ordinary background rafi. */
  readonly detach?: boolean;
}

export type StartUI = RunUI & AttachUI & ScopeUI;

export async function startBuild(engine: Engine, o: StartOptions, ui: StartUI): Promise<number> {
  const { deps } = engine;
  await pruneInterviews(deps.fs, engine.projectDir, deps.clock.now());
  const previous = await previousBuild(engine);
  if ("live" in previous) return liveBuild(previous.live, o.tty, ui);
  // C189: a stacks build uses per-ticket branches and `pr` completion unless its flags say otherwise.
  const flags = o.stacks ? { ...o, branchPerTicket: o.branchPerTicket ?? true, completion: o.completion ?? "pr" } : o;
  const loaded = await settingsFor(deps, engine.projectDir, flags, (text) => ui.line(text));
  if (!loaded.ok) { ui.line(loaded.message); return 1; }
  const { settings, config } = loaded;
  const first = await prepareRun(engine, settings, { tty: o.tty, ticket: o.ticket, dirtyWork: o.dirtyWork }, ui);
  if (typeof first === "number") return first;
  await adoptProject(engine, config, first.tickets.tickets.map((t) => t.id));
  const run = deps.random.id();
  const fresh = await freshScope(engine, o, first, settings, ui, run);
  if (typeof fresh === "number") return fresh;
  const { chosen, prepared } = fresh;
  const recorded = Object.fromEntries(Object.entries({ ...settings, ...prepared.extra })
    .map(([k, v]) => [k, { value: v.value ?? null, source: v.source }]));
  const started: NewEvent = { type: "build.started", run_id: run, actor: "user", source: "terminal",
    data: { workflow: { id: standard.id, version: standard.version, digest: workflowDigest(standard) },
      scope: chosen.scope, tickets: chosen.tickets, settings: recorded, engine_version: ENGINE_VERSION,
      argv: [...o.argv] } };
  const waiver = chosen.waiver;
  // A detached build's parent writes build.started under the same checks and takes no lease (C151).
  const mine: NewEvent[] = [started, ...chosen.events, ...(o.detach ? [] : [acquired(engine, run)])];
  const decide = (p: Previous) => ("live" in p ? { done: p.live } : { ...p, events: [...p.events, ...mine] });
  const claimed = await claimRun<Fresh, string>(engine, o.detach ? null : run, decide(previous),
    async () => decide(await previousBuild(engine)));
  if ("done" in claimed || "live" in claimed) {
    return liveBuild("done" in claimed ? claimed.done : claimed.live, o.tty, ui);
  }
  if ("lost" in claimed) { ui.line(`Build ${run} couldn't take its lease.`); return 1; }
  if (claimed.owned.line) ui.line(claimed.owned.line);
  if (o.detach) return detachBuild(engine, run, ui, waiver);
  await waiver?.();
  const ctx = contextFor(engine, run, settings, prepared, ui);
  return runLoop(ctx, prepared.tickets.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
}
