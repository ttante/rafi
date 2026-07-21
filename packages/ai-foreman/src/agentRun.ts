import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, DEFAULT_CONFIG, type PermissionConfig } from "./config.js";
import { Log } from "./log.js";
import { PermissionPolicy } from "./permissions/policy.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { Foreman, createPermissionHandler, type StepStatus } from "./foreman.js";
import type { BuilderAdapter, BuilderAdapterOptions, EffortLevel, TurnResult } from "./adapters/types.js";
import { printEvents } from "./cli/events.js";
import { loadRoleBundle, type RoleBundle } from "./roles.js";
import { ensureRuntimeReadyForCommand } from "./cli/runtimeAuthPrompt.js";
import { resolveAgentForProject } from "./cli/runtimeSelection.js";
import type { AgentRuntime } from "./runtimeAuth.js";

export type { EffortLevel } from "./adapters/types.js";

export const VALID_EFFORT: readonly EffortLevel[] = ["low", "medium", "high", "xhigh"];

export interface RoleBuilderOptions {
  projectDir: string;
  role: string;
  agent?: string;
  model?: string;
  effort?: EffortLevel;
  fast?: boolean;
  yes?: boolean;
  allowSwitch?: boolean;
  label: string;
  log: Log;
  permissionConfig?: PermissionConfig;
  extraSkills?: string[];
  sandboxMode?: BuilderAdapterOptions["sandboxMode"];
  resumeSessionId?: string;
}

export interface RoleBuilder {
  builder: BuilderAdapter;
  runtime: AgentRuntime;
  model?: string;
  effort?: EffortLevel;
  roleBundle: RoleBundle;
  skills: string[];
}

export interface RoleInstructionRunOptions extends Omit<RoleBuilderOptions, "log"> {
  instruction: string;
  logPath?: string;
  logEvent?: "rafi-plan" | "ticket-populate" | "preflight";
}

export interface RoleInstructionRunResult {
  turn: { result: TurnResult; status: StepStatus };
  runtime: AgentRuntime;
  model?: string;
  effort?: EffortLevel;
  logPath: string;
  roleBundle: RoleBundle;
  skills: string[];
}

export function assertEffortLevel(effort: string | undefined): asserts effort is EffortLevel | undefined {
  if (effort && !VALID_EFFORT.includes(effort as EffortLevel)) {
    throw new Error(`unknown effort "${effort}" - choose: ${VALID_EFFORT.join(" | ")}`);
  }
}

export function makeLogPath(projectDir: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(projectDir, ".foreman", `${stamp}-${label}.jsonl`);
}

export function mergeSkills(roleSkills: readonly string[], extraSkills: readonly string[] = []): string[] {
  return [...new Set([...roleSkills, ...extraSkills])];
}

export function readOnlyPermissionConfig(): PermissionConfig {
  return {
    allowBash: [
      "pwd",
      "ls",
      "cat ",
      "sed -n ",
      "grep ",
      "rg ",
      "head ",
      "tail ",
      "wc ",
      "git status",
      "git diff",
      "git log",
      "git show",
      "git ls-files",
      "git grep",
    ],
    escalateBash: [
      ...DEFAULT_CONFIG.permissions.escalateBash,
      "git add",
      "git commit",
      "git checkout",
      "git restore",
      "git stash",
      "npm install",
      "npm run",
      "npm ci",
      "pnpm ",
      "yarn ",
      "mkdir ",
      "touch ",
      "mv ",
      "cp ",
      "rm ",
      "ai-foreman tickets",
      "foreman tickets",
    ],
    allowTools: ["Read", "Glob", "Grep", "TodoWrite"],
    escalateTools: [
      ...new Set([
        ...DEFAULT_CONFIG.permissions.escalateTools,
        "Edit",
        "Write",
        "MultiEdit",
        "NotebookEdit",
      ]),
    ],
  };
}

export async function createRoleBuilder(opts: RoleBuilderOptions): Promise<RoleBuilder> {
  if (!existsSync(opts.projectDir)) {
    throw new Error(`project directory not found: ${opts.projectDir}`);
  }
  assertEffortLevel(opts.effort);

  let runtime = resolveAgentForProject(opts.projectDir, opts.agent);
  const config = loadConfig(join(opts.projectDir, "foreman.yaml"));
  const roleBundle = loadRoleBundle(opts.role, { projectDir: opts.projectDir });
  const initialModel = opts.model ?? roleBundle.model ?? undefined;
  const effort = opts.effort ?? (roleBundle.effort as EffortLevel | null) ?? undefined;
  const ready = await ensureRuntimeReadyForCommand(opts.projectDir, runtime, {
    label: opts.label,
    yes: Boolean(opts.yes),
    allowSwitch: opts.allowSwitch,
    model: initialModel,
  });
  runtime = ready.runtime;
  const model = ready.model;

  const policy = new PermissionPolicy(opts.permissionConfig ?? config.permissions, opts.projectDir);
  const skills = mergeSkills(roleBundle.skills, opts.extraSkills);
  const adapterOpts: BuilderAdapterOptions = {
    cwd: opts.projectDir,
    model,
    resumeSessionId: opts.resumeSessionId,
    permission: createPermissionHandler(policy, opts.log),
    effort,
    fast: opts.fast,
    sandboxMode: opts.sandboxMode,
    systemPromptAppend: roleBundle.system || undefined,
    skills: skills.length > 0 ? skills : undefined,
  };
  const builder: BuilderAdapter =
    runtime === "codex"
      ? new CodexAdapter(adapterOpts)
      : await ClaudeAdapter.create(adapterOpts);

  return { builder, runtime, model, effort, roleBundle, skills };
}

export async function runRoleInstruction(opts: RoleInstructionRunOptions): Promise<RoleInstructionRunResult> {
  const logPath = opts.logPath ?? makeLogPath(opts.projectDir, opts.label.replace(/\s+/g, "-"));
  const log = new Log(logPath);
  const { builder, runtime, model, effort, roleBundle, skills } = await createRoleBuilder({
    ...opts,
    log,
  });
  const viewer = printEvents(builder.events());
  const config = loadConfig(join(opts.projectDir, "foreman.yaml"));
  const foreman = new Foreman(builder, log, config.notifications.enabled, false, 3, opts.projectDir);

  try {
    const turn = await foreman.runInstruction(opts.instruction);
    await builder.close();
    await viewer;

    if (opts.logEvent) {
      log.write(opts.logEvent, {
        role: opts.role,
        statusKind: turn.status.kind,
        summary: turn.status.summary,
        reason: turn.status.reason,
        costUsd: turn.result.costUsd,
        isError: turn.result.isError,
      });
    }

    return { turn, runtime, model, effort, logPath, roleBundle, skills };
  } catch (err) {
    await builder.close().catch(() => {});
    await viewer.catch(() => {});
    log.write("error", { message: String(err) });
    throw err;
  }
}
