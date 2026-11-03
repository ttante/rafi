// engine.start (ARCH 8.3): settings in layers with their sources, the tickets, the checks before any agent turn
// (a first commit, the test sandbox or the no-sandbox decision, C60), the agent per role (C34), build.started with
// the pinned workflow, then the loop. Returns the exit code; every user-facing line goes through `ui`.
import path from "node:path";
import { layered, loadConfig, type Flags } from "../config/load.js";
import type { Settings } from "rafi-spec/v1";
import { splitCommand } from "../agents/shellForms.js";
import { findOnPath } from "../agents/readiness.js";
import { checkModel } from "../agents/capabilities.js";
import { claudeAgent } from "../agents/claude/adapter.js";
import { codexAgent } from "../agents/codex/adapter.js";
import { agentEnv, declaredValues } from "../build/env.js";
import { runLoop } from "../build/loop.js";
import type { BuildContext, BuildUI, RoleAgent } from "../build/context.js";
import {
  noSandboxDecision, rememberNoSandbox, sandboxInfo, savedNoSandbox, stopLine, WARNING,
} from "../build/sandbox.js";
import type { SandboxTool } from "../deps/types.js";
import { loadTickets } from "../tickets/load.js";
import { standard } from "../workflow/standard.js";
import { workflowDigest } from "../workflow/load.js";
import type { Engine } from "./engine.js";

export const ENGINE_VERSION = "1.0.0-next.0";

export interface StartOptions extends Flags {
  readonly argv: readonly string[];
  readonly steps?: number;
  readonly ticket?: string;
  readonly tty: boolean;
}

export interface StartUI extends BuildUI {
  /** The no-sandbox warning in a terminal: true runs the tests without one (C60 d). */
  confirmNoSandbox?(warning: string): Promise<boolean>;
}

type Roles = Record<"builder" | "qa", RoleAgent>;

async function roleAgents(settings: Settings, deps: Engine["deps"]): Promise<{ roles: Roles; extra: Settings }> {
  const roles = (settings["agent_defaults.roles"]?.value ?? {}) as Record<string, Record<string, unknown>>;
  const targets = settings["harness.targets"]!;
  const extra: Settings = {};
  const out = {} as Roles;
  for (const role of ["builder", "qa"] as const) {
    const own = roles[role] ?? {};
    const pick = <T>(key: string, flag: string, fallback: T): { value: T; source: string } => {
      const f = settings[flag];
      if (f) return { value: f.value as T, source: "flag" };
      if (own[key] !== undefined) return { value: own[key] as T, source: "project" };
      return { value: fallback, source: "default" };
    };
    const list = targets.value as string[];
    const runtime = settings["agent.runtime"] ? { value: settings["agent.runtime"].value as "codex" | "claude",
      source: "flag" } : own.make ? { value: own.make as "codex" | "claude", source: "project" }
      : list.length === 1 ? { value: list[0] as "codex" | "claude", source: targets.source }
        : { value: "claude" as const, source: "default" };
    const model = pick<string | null>("model", "agent.model", null);
    const effort = pick<string | null>("reasoning", "agent.effort", null);
    const fast = pick<boolean>("fast", "agent.fast", false);
    Object.assign(extra, { [`agent.${role}.runtime`]: runtime, [`agent.${role}.model`]: model,
      [`agent.${role}.effort`]: effort, [`agent.${role}.fast`]: fast });
    out[role] = { runtime: runtime.value, model: model.value, effort: effort.value, fast: fast.value,
      structured: true, executable: (await findOnPath(deps.fs, deps.env, runtime.value)) ?? runtime.value };
  }
  return { roles: out, extra };
}

/** C52: a configured model the provider doesn't list is flagged before the first turn; text replies then. */
async function modelFlag(engine: Engine, roles: Roles, role: "builder" | "qa", agentsEnv: readonly string[]):
  Promise<string | null> {
  const a = roles[role];
  if (!a.model) return null;
  const { deps } = engine;
  const env = agentEnv(deps.env, a.runtime, agentsEnv, deps.machine.platform, role);
  const agent = a.runtime === "codex" ? codexAgent({ deps, cwd: engine.projectDir, executable: a.executable, env })
    : claudeAgent({ deps, cwd: engine.projectDir, env,
      executable: path.isAbsolute(a.executable) ? a.executable : undefined });
  try {
    const listed = await agent.models?.().catch(() => null) ?? null;
    return checkModel(a.runtime, a.model, listed, role).flag;
  } finally {
    await agent.close();
  }
}

/** C42: checks.test_runner, else the package.json test script through the lockfile's package manager. */
async function runner(engine: Engine, settings: Settings): Promise<{ argv: string[] | null; scripts: string[] }> {
  const fs = engine.deps.fs;
  const pkgFile = path.join(engine.projectDir, "package.json");
  let scripts: string[] = [];
  if (await fs.stat(pkgFile)) {
    try { scripts = Object.keys((JSON.parse(await fs.read(pkgFile)) as { scripts?: object }).scripts ?? {}); } catch {
      scripts = [];
    }
  }
  const tests = scripts.filter((s) => s === "test" || s.startsWith("test:"));
  const configured = settings["checks.test_runner"]?.value as string | undefined;
  if (configured) { const s = splitCommand(configured); return { argv: s.ok ? s.argv : null, scripts: tests }; }
  if (!tests.includes("test")) return { argv: null, scripts: tests };
  const manager = (await fs.stat(path.join(engine.projectDir, "pnpm-lock.yaml"))) ? "pnpm"
    : (await fs.stat(path.join(engine.projectDir, "yarn.lock"))) ? "yarn" : "npm";
  settings["checks.test_runner"] = { value: `${manager} test`, source: "default" };
  return { argv: [manager, "test"], scripts: tests };
}

async function sandboxFor(engine: Engine, settings: Settings, o: StartOptions, ui: StartUI):
  Promise<{ tool: SandboxTool | null } | { code: number }> {
  const info = sandboxInfo(await engine.deps.checks.sandbox());
  if (info.available) { settings.sandbox = { value: "os", source: "default" }; return { tool: info.tool }; }
  const { fs, machine } = engine.deps;
  const saved = await savedNoSandbox(fs, machine.stateDir, engine.projectDir);
  const decision = noSandboxDecision({ saved, setting: settings["checks.run_without_sandbox"]?.value === true,
    autoApprove: settings["approvals.mode"]?.value === "auto", tty: o.tty });
  if (decision === "stop") { ui.line(stopLine(info.missing)); return { code: 1 }; }
  if (decision === "ask") {
    if (!(await ui.confirmNoSandbox?.(WARNING(info.missing)))) {
      ui.line("Cancelled; nothing ran.");
      return { code: 0 };
    }
  }
  const source = decision === "ask" ? "terminal" : decision;
  if (decision === "ask" || decision === "auto-approve") {
    await rememberNoSandbox(fs, machine.stateDir, engine.projectDir, engine.deps.clock.now().toISOString());
    ui.line(`Tests will run without a sandbox on this machine for this project (saved in ` +
      `${path.join(machine.stateDir, "grants.yaml")}; remove the entry to be asked again).`);
  }
  settings.sandbox = { value: "none", source };
  return { tool: null };
}

async function ensureIgnored(engine: Engine): Promise<void> {
  const file = path.join(engine.projectDir, ".rafi", ".gitignore");
  if (!(await engine.deps.fs.stat(file))) await engine.deps.fs.writeAtomic(file, "*\n!progress.yaml\n");
}

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
  const config = await loadConfig(deps.fs, engine.projectDir);
  if (!config.ok) { ui.line(config.message); return 1; }
  const settings = layered(config.config, o);
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
  const sandbox = await sandboxFor(engine, settings, o, ui);
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
  await adoptProject(engine, config.config, tickets.tickets.map((t) => t.id));
  const run = deps.random.id();
  const scope = o.ticket ? { kind: "ticket", value: o.ticket, skip: [] } : o.steps
    ? { kind: "steps", value: o.steps, skip: [] } : { kind: "all", value: null, skip: [] };
  const recorded = Object.fromEntries(Object.entries({ ...settings, ...extra })
    .map(([k, v]) => [k, { value: v.value ?? null, source: v.source }]));
  const self = deps.processes.self();
  await engine.append([{ type: "build.started", run_id: run, actor: "user", source: "terminal", data: {
    workflow: { id: standard.id, version: standard.version, digest: workflowDigest(standard) }, scope,
    tickets: o.ticket ? [o.ticket] : [], settings: recorded, engine_version: ENGINE_VERSION, argv: [...o.argv] } },
  { type: "build.owner_acquired", run_id: run, actor: "engine", data: { instance: self.instance, host: self.host,
    pid: self.pid } }]);
  const ctx: BuildContext = { engine, deps, project: engine.projectDir, run, tickets: tickets.tickets,
    units: tickets.units, settings, agents: roles, sandbox: sandbox.tool, grants: { needs: [] }, runner: test.argv,
    testScripts: test.scripts, ui, sessions: new Map() };
  return runLoop(ctx, tickets.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
}
