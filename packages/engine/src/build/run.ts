// What a run needs before its loop (start, resume and a detached build's first owner share it): the declared values
// registered with the redactor, the tickets, a first commit, the test sandbox or the no-sandbox decision (C60), the
// agent per role (C34) with C52's model check, the test runner (C42), `.rafi/.gitignore`; then the loop's context.
import path from "node:path";
import type { Settings } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import { modelFlag, roleAgents, type Roles } from "../agents/roles.js";
import { sandboxFor, type UpfrontUI } from "../ask/upfront.js";
import { runner } from "../config/runner.js";
import type { SandboxTool } from "../deps/types.js";
import { loadTickets } from "../tickets/load.js";
import type { BuildContext, BuildUI } from "./context.js";
import { declaredValues } from "./env.js";

/** What start and resume show and ask before the loop. */
export type RunUI = BuildUI & UpfrontUI;

async function ensureIgnored(engine: Engine): Promise<void> {
  const file = path.join(engine.projectDir, ".rafi", ".gitignore");
  if (!(await engine.deps.fs.stat(file))) await engine.deps.fs.writeAtomic(file, "*\n!progress.yaml\n");
}

/** What a run needs before its loop, from its settings (start and resume share it). A number is an exit code. */
export interface Prepared {
  readonly tickets: Awaited<ReturnType<typeof loadTickets>> & { ok: true };
  readonly roles: Roles;
  readonly extra: Settings;
  readonly sandbox: SandboxTool | null;
  readonly test: { argv: string[] | null; scripts: string[] };
}

export async function prepareRun(engine: Engine, settings: Settings, o: { tty: boolean; ticket?: string },
  ui: RunUI): Promise<Prepared | number> {
  const { deps } = engine;
  const declared = ["checks.env", "agents.env"].flatMap((k) => (settings[k]?.value as string[] | undefined) ?? []);
  for (const [name, value] of declaredValues(deps.env, declared, deps.machine.platform)) {
    engine.secret(value, name);
  }
  const tickets = await loadTickets(deps.fs, engine.projectDir);
  if (!tickets.ok) { ui.line(tickets.message); return 1; }
  if (!tickets.tickets.length) { ui.line("There are no tickets in .tickets/tickets.yaml to build."); return 1; }
  if (o.ticket && !tickets.tickets.some((t) => t.id === o.ticket)) {
    ui.line(`There's no ticket ${o.ticket}.`);
    return 1;
  }
  const head = await deps.git(["rev-parse", "--verify", "-q", "HEAD"], { cwd: engine.projectDir, env: deps.env });
  if (head.code !== 0) {
    ui.line("this repository has no commit yet; make the first one with `git add -A && git commit -m \"First " +
      "commit\"`, then run `rafi start` again.");
    return 1;
  }
  const sandbox = await sandboxFor(engine, settings, { tty: o.tty }, ui);
  if ("code" in sandbox) return sandbox.code;
  const { roles, extra } = await roleAgents(settings, deps);
  for (const role of ["builder", "qa"] as const) {
    const flag = await modelFlag(engine, roles, role, (settings["agents.env"]?.value as string[] | undefined) ?? []);
    if (flag) {
      ui.line(flag);
      roles[role] = { ...roles[role], structured: false };
    }
  }
  const test = await runner(engine, settings);
  await ensureIgnored(engine);
  return { tickets, roles, extra, sandbox: sandbox.tool, test };
}

/** The loop's context for a run, from its settings and what prepareRun found. */
export function contextFor(engine: Engine, run: string, settings: Settings, p: Prepared, ui: BuildUI): BuildContext {
  return { engine, deps: engine.deps, project: engine.projectDir, run, tickets: p.tickets.tickets,
    units: p.tickets.units, settings, agents: p.roles, sandbox: p.sandbox, grants: { needs: [] }, runner: p.test.argv,
    testScripts: p.test.scripts, ui, sessions: new Map(), heads: new Map() };
}
