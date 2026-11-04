// engine.start (ARCH 8.3): settings in layers with their sources, the tickets, the checks before any agent turn
// (a first commit, the test sandbox or the no-sandbox decision, C60), the agent per role (C34), build.started with
// the pinned workflow, then the loop. Returns the exit code; every user-facing line goes through `ui`.
import { layered, loadConfig, type Flags } from "../config/load.js";
import { runLoop } from "../build/loop.js";
import { staleWaiver } from "../ask/blocked.js";
import { detachBuild } from "../build/detach.js";
import { contextFor, prepareRun, type RunUI } from "../build/run.js";
import { standard } from "../workflow/standard.js";
import { workflowDigest } from "../workflow/load.js";
import type { Engine } from "./engine.js";
import type { NewEvent } from "../log/types.js";
import { pruneInterviews } from "../setup/interviews.js";
import {
  acquired, claimRun, liveBuild, previousBuild, type AttachUI, type Fresh, type Previous,
} from "../build/claim.js";

export const ENGINE_VERSION = "1.0.0-next.0";

export interface StartOptions extends Flags {
  readonly argv: readonly string[];
  readonly steps?: number;
  readonly ticket?: string;
  readonly tty: boolean;
  /** `--detach` (ARCH 8.7): the build runs in one ordinary background rafi. */
  readonly detach?: boolean;
}

export type StartUI = RunUI & AttachUI;

/**
 * ARCH 4.4's row "— (no project yet; a 1.0 config and tickets on disk) → `ready`, recorded by the first command that
 * writes, as `project.created` plus `tickets.changed` (added)" (P19, C62): a project written by hand, by the harness
 * or a fresh clone. `start` is the only M2 command that writes the log.
 */
async function adoptProject(engine: Engine, config: Record<string, unknown>, ids: readonly string[]): Promise<void> {
  const defs = ids.map((id) => ({ id, dependsOn: [] }));
  if (!ids.length || engine.fold(defs).project.state !== "none") return;
  await engine.append([{ type: "project.created", actor: "engine", data: { app_name: String(config.app_name ?? ""),
    rafi_version: ENGINE_VERSION } }, { type: "tickets.changed", actor: "engine", data: { by: "user",
    items: ids.map((ticket) => ({ ticket, field: "added" })), material: false } }]);
}

export async function startBuild(engine: Engine, o: StartOptions, ui: StartUI): Promise<number> {
  const { deps } = engine;
  await pruneInterviews(deps.fs, engine.projectDir, deps.clock.now());
  const previous = await previousBuild(engine);
  if ("live" in previous) return liveBuild(previous.live, o.tty, ui);
  const config = await loadConfig(deps.fs, engine.projectDir);
  if (!config.ok) { ui.line(config.message); return 1; }
  const settings = layered(config.config, o);
  const prepared = await prepareRun(engine, settings, { tty: o.tty, ticket: o.ticket }, ui);
  if (typeof prepared === "number") return prepared;
  await adoptProject(engine, config.config, prepared.tickets.tickets.map((t) => t.id));
  const run = deps.random.id();
  const scope = o.ticket ? { kind: "ticket", value: o.ticket, skip: [] } : o.steps
    ? { kind: "steps", value: o.steps, skip: [] } : { kind: "all", value: null, skip: [] };
  const recorded = Object.fromEntries(Object.entries({ ...settings, ...prepared.extra })
    .map(([k, v]) => [k, { value: v.value ?? null, source: v.source }]));
  const started: NewEvent = { type: "build.started", run_id: run, actor: "user", source: "terminal",
    data: { workflow: { id: standard.id, version: standard.version, digest: workflowDigest(standard) }, scope,
      tickets: o.ticket ? [o.ticket] : [], settings: recorded, engine_version: ENGINE_VERSION, argv: [...o.argv] } };
  const waiver = o.ticket ? () => staleWaiver(engine, deps, run, o.ticket!, (text) => ui.line(text)) : undefined;
  // A detached build's parent writes build.started under the same checks and takes no lease (C151).
  const mine: NewEvent[] = o.detach ? [started] : [started, acquired(engine, run)];
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
