import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, DEFAULT_CONFIG, type PermissionConfig } from "./config.js";
import { Log } from "./log.js";
import { PermissionPolicy } from "./permissions/policy.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { RecoveringAdapter } from "./adapters/recovering.js";
import { SessionUnavailableError } from "./adapters/sessionFailure.js";
import { Foreman, createPermissionHandler, type StepStatus } from "./foreman.js";
import type { BuilderAdapter, BuilderAdapterOptions, EffortLevel, TurnResult } from "./adapters/types.js";
import type { AnsweredProviderQuestion } from "./providerQuestions.js";
import { printEvents } from "./cli/events.js";
import { loadRoleBundle, type RoleBundle } from "./roles.js";
import { ensureRuntimeReadyForCommand } from "./cli/runtimeAuthPrompt.js";
import { resolveAgentForProject } from "./cli/runtimeSelection.js";
import type { AgentRuntime } from "./runtimeAuth.js";
import { parse as parseYaml } from "yaml";
import type { AgentDefaultsV1, AgentRoleDefaultsV1, ConfigurableAgentRole, ProviderSessionRefV1 } from "rafi-spec";
import { captureWorkspaceIdentity, createProviderSessionRef, resolveUniqueSessionBinding } from "./sessionIdentity.js";
import { WorkflowDb } from "./workflowDb.js";

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
  log?: Log;
  permissionConfig?: PermissionConfig;
  extraSkills?: string[];
  sandboxMode?: BuilderAdapterOptions["sandboxMode"];
  /** Disable recovery-session persistence for isolated, non-recoverable roles such as Manager. */
  persistSessionBindings?: boolean;
  resumeSessionId?: string;
  /** Location-scoped exact session. Raw IDs are resolved through durable project bindings or treated as legacy candidates. */
  resumeSessionRef?: ProviderSessionRefV1;
  /** Observe successfully answered provider-native questions. */
  onAnsweredQuestion?: (event: AnsweredProviderQuestion) => void;
  /** Observe any provider-native question attempt, including denied prompts. */
  onProviderQuestion?: (request: import("./adapters/types.js").PermissionRequest) => void;
}

export interface RoleBuilder {
  builder: BuilderAdapter;
  runtime: AgentRuntime;
  model?: string;
  effort?: EffortLevel;
  roleBundle: RoleBundle;
  skills: string[];
  log: Log;
}

export interface RoleInstructionRunOptions extends Omit<RoleBuilderOptions, "log"> {
  instruction: string;
  logPath?: string;
  logEvent?: "rafi-plan" | "ticket-populate" | "preflight" | "uninstall-proposal";
}

export interface RoleInstructionRunResult {
  turn: { result: TurnResult; status: StepStatus };
  runtime: AgentRuntime;
  model?: string;
  effort?: EffortLevel;
  sessionId?: string;
  sessionRef?: ProviderSessionRefV1;
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
      "git diff --stat",
      "git diff --name-only",
      "git log --oneline",
      "git show --stat",
      "git ls-files",
      "git grep",
    ],
    escalateBash: [
      ...DEFAULT_CONFIG.permissions.escalateBash,
      " --output",
      " -o",
      " --exec",
      " --format",
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
    strictShellRedirection: true,
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
  const saved = readRoleDefaultsForExecution(opts.projectDir, opts.role);
  if (opts.resumeSessionRef && opts.resumeSessionId && opts.resumeSessionRef.sessionId !== opts.resumeSessionId) {
    throw new Error("resume session ID does not match the supplied location-scoped reference");
  }
  let requestedResumeRef = opts.resumeSessionRef;
  if (!requestedResumeRef && opts.resumeSessionId) {
    const bindingDb = new WorkflowDb(opts.projectDir);
    try { requestedResumeRef = resolveUniqueSessionBinding(bindingDb.providerSessionBindings(opts.resumeSessionId), opts.resumeSessionId); }
    finally { bindingDb.close(); }
  }
  const configuredEffort = saved?.reasoning && saved.reasoning !== "default" ? saved.reasoning : undefined;
  const effectiveEffort = opts.effort ?? (VALID_EFFORT.includes(configuredEffort as EffortLevel) ? configuredEffort as EffortLevel : undefined);
  assertEffortLevel(effectiveEffort);

  let runtime = resolveAgentForProject(opts.projectDir, opts.agent ?? requestedResumeRef?.provider ?? saved?.make);
  if (requestedResumeRef && requestedResumeRef.provider !== runtime) {
    throw new Error(`session ${requestedResumeRef.sessionId} belongs to ${requestedResumeRef.provider}, but ${runtime} was selected`);
  }
  if (requestedResumeRef && requestedResumeRef.role !== configurableRole(opts.role)) {
    throw new Error(`session ${requestedResumeRef.sessionId} belongs to role ${requestedResumeRef.role}, not ${configurableRole(opts.role)}`);
  }
  const config = loadConfig(join(opts.projectDir, "foreman.yaml"));
  const log = opts.log ?? new Log(makeLogPath(opts.projectDir, opts.label.replace(/\s+/g, "-")));
  const roleBundle = loadRoleBundle(opts.role, { projectDir: opts.projectDir });
  const initialModel = opts.model ?? (saved?.model !== "default" ? saved?.model : undefined) ?? roleBundle.model ?? undefined;
  const effort = effectiveEffort ?? (roleBundle.effort as EffortLevel | null) ?? undefined;
  const ready = await ensureRuntimeReadyForCommand(opts.projectDir, runtime, {
    label: opts.label,
    yes: Boolean(opts.yes),
    allowSwitch: requestedResumeRef || opts.resumeSessionId ? false : opts.allowSwitch,
    model: initialModel,
  });
  runtime = ready.runtime;
  let model = ready.model;
  let runtimeExecutable = ready.executable;

  const policy = new PermissionPolicy(opts.permissionConfig ?? config.permissions, opts.projectDir);
  const skills = mergeSkills(roleBundle.skills, opts.extraSkills);
  const interactive = !opts.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const makeAdapter = async (nextRuntime: AgentRuntime, resumeSessionId?: string, resumeSessionRef?: ProviderSessionRefV1): Promise<BuilderAdapter> => {
    let scopedRef = resumeSessionRef;
    if (!scopedRef && resumeSessionId) {
      const bindingDb = new WorkflowDb(opts.projectDir);
      try { scopedRef = resolveUniqueSessionBinding(bindingDb.providerSessionBindings(resumeSessionId), resumeSessionId); }
      finally { bindingDb.close(); }
      scopedRef ??= createProviderSessionRef({
        provider: nextRuntime,
        sessionId: resumeSessionId,
        role: configurableRole(opts.role),
        stream: opts.role,
        generation: 0,
        cwd: opts.projectDir,
        configRoot: opts.projectDir,
        workspaceIdentity: captureWorkspaceIdentity(opts.projectDir),
        source: "legacy-inferred",
      });
    }
    if (scopedRef && scopedRef.provider !== nextRuntime) {
      throw new Error(`session ${scopedRef.sessionId} belongs to ${scopedRef.provider}, but ${nextRuntime} was selected`);
    }
    const adapterOpts: BuilderAdapterOptions = {
      cwd: opts.projectDir,
      configRoot: opts.projectDir,
      runtimeExecutable,
      runtimePhase: phaseForRole(opts.role),
      model,
      ...(scopedRef ? { resumeSessionRef: scopedRef } : {}),
      sessionRole: configurableRole(opts.role),
      sessionStream: opts.role,
      sessionGeneration: scopedRef?.generation ?? 0,
      workspaceIdentity: captureWorkspaceIdentity(opts.projectDir),
      permission: createPermissionHandler(policy, log, {
        interactive,
        onAnsweredQuestion: opts.onAnsweredQuestion,
        onProviderQuestion: opts.onProviderQuestion,
      }),
      effort,
      fast: opts.fast ?? saved?.fast,
      sandboxMode: opts.sandboxMode,
      systemPromptAppend: roleBundle.system || undefined,
      skills: skills.length > 0 ? skills : undefined,
    };
    const adapter = nextRuntime === "codex"
      ? new CodexAdapter(adapterOpts)
      : await ClaudeAdapter.create(adapterOpts);
    if (scopedRef && adapter.agent === "codex") {
      const availability = await adapter.validateSession!();
      if (availability.status !== "available") {
        await adapter.close().catch(() => {});
        throw new SessionUnavailableError({
          runtime: "codex",
          phase: "preflight",
          dispatchState: "not-sent",
          executable: runtimeExecutable,
          cwd: opts.projectDir,
          diagnostics: availability.detail ?? `Codex session ${scopedRef.sessionId} is ${availability.status}`,
          availability,
        });
      }
    }
    return adapter;
  };
  const initial = await makeAdapter(runtime, opts.resumeSessionId, requestedResumeRef);
  const persistSessionRef = (ref: ProviderSessionRefV1): void => {
    if (opts.persistSessionBindings === false) return;
    const bindingDb = new WorkflowDb(opts.projectDir);
    try { bindingDb.recordProviderSessionBinding(ref); }
    finally { bindingDb.close(); }
  };
  const initialRef = initial.sessionRef?.();
  if (initialRef) persistSessionRef(initialRef);
  const builder: BuilderAdapter = new RecoveringAdapter({
    initial,
    runtime,
    label: opts.label,
    enabled: interactive,
    allowSwitch: opts.allowSwitch !== false && !opts.resumeSessionId && !requestedResumeRef,
    recreate: async (nextRuntime, resumeSessionId, resumeSessionRef) => {
      const nextReady = await ensureRuntimeReadyForCommand(opts.projectDir, nextRuntime, {
        label: opts.label,
        allowSwitch: false,
        model: nextRuntime === runtime ? model : undefined,
      });
      runtime = nextReady.runtime;
      model = nextReady.model;
      runtimeExecutable = nextReady.executable;
      return makeAdapter(runtime, resumeSessionId, resumeSessionRef);
    },
    onSessionRef: persistSessionRef,
  });

  return { builder, runtime, model, effort, roleBundle, skills, log };
}

function phaseForRole(role: string): BuilderAdapterOptions["runtimePhase"] {
  if (role === "planner") return "planning";
  if (role === "ticket-maker") return "ticket-population";
  if (role === "qa") return "qa";
  if (role === "uninstaller") return "uninstaller";
  if (role === "manager") return "manager";
  return "builder";
}

export function readRoleDefaultsForExecution(projectDir: string, role: string): AgentRoleDefaultsV1 | undefined {
  const path = join(projectDir, "rafi-config.yaml");
  if (!existsSync(path)) return undefined;
  try {
    const config = parseYaml(readFileSync(path, "utf8")) as { agent_defaults?: AgentDefaultsV1 } | undefined;
    const saved = config?.agent_defaults?.version === 1
      ? config.agent_defaults.roles[role as ConfigurableAgentRole]
      : undefined;
    if (!saved) return undefined;
    if (role === "manager") return saved;
    if (isFullyInitializedTracker(projectDir)) return saved;
    const { make: _pendingMake, ...active } = saved;
    return active;
  } catch {
    return undefined;
  }
}

function isFullyInitializedTracker(projectDir: string): boolean {
  try {
    const trackerPath = join(projectDir, ".tickets", "config.yaml");
    const ticketsPath = join(projectDir, ".tickets", "tickets.yaml");
    const statePath = join(projectDir, ".tickets", "ticket-state.sqlite");
    if (!existsSync(trackerPath) || !existsSync(ticketsPath) || !existsSync(statePath)) return false;
    const tracker = parseYaml(readFileSync(trackerPath, "utf8"));
    if (!tracker || typeof tracker !== "object" || Array.isArray(tracker)) return false;
    const tickets = parseYaml(readFileSync(ticketsPath, "utf8")) as { tickets?: unknown } | undefined;
    if (!tickets || !Array.isArray(tickets.tickets)) return false;
    if (!statSync(statePath).isFile()) return false;
    return readFileSync(statePath).subarray(0, 16).toString("utf8") === "SQLite format 3\u0000";
  } catch {
    return false;
  }
}

export async function runRoleInstruction(opts: RoleInstructionRunOptions): Promise<RoleInstructionRunResult> {
  const logPath = opts.logPath ?? makeLogPath(opts.projectDir, opts.label.replace(/\s+/g, "-"));
  const log = new Log(logPath);
  const roleBuilder = await createRoleBuilder({
    ...opts,
    log,
  });
  const { builder, effort, roleBundle, skills } = roleBuilder;
  const viewer = printEvents(builder.events());
  const config = loadConfig(join(opts.projectDir, "foreman.yaml"));
  const foreman = new Foreman(builder, log, { desktop: config.notifications.enabled, terminalBell: config.notifications.terminal_bell }, false, 3, opts.projectDir);

  try {
    const turn = await foreman.runInstruction(opts.instruction);
    await builder.close();
    await viewer;

    if (opts.logEvent) {
      log.write(opts.logEvent, {
        role: opts.role,
        runtime: builder.agent,
        model: builder.agent === roleBuilder.runtime ? roleBuilder.model : undefined,
        effort,
        sessionId: builder.sessionId(),
        sessionRef: builder.sessionRef?.(),
        statusKind: turn.status.kind,
        summary: turn.status.summary,
        reason: turn.status.reason,
        costUsd: turn.result.costUsd,
        isError: turn.result.isError,
      });
    }

    return {
      turn,
      runtime: builder.agent,
      model: builder.agent === roleBuilder.runtime ? roleBuilder.model : undefined,
      effort,
      sessionId: builder.sessionId(),
      sessionRef: builder.sessionRef?.(),
      logPath,
      roleBundle,
      skills,
    };
  } catch (err) {
    await builder.close().catch(() => {});
    await viewer.catch(() => {});
    log.write("error", { message: String(err) });
    throw err;
  }
}

function configurableRole(role: string): ConfigurableAgentRole {
  return ["builder", "qa", "planner", "ticket-maker", "uninstaller", "manager"].includes(role)
    ? role as ConfigurableAgentRole
    : "builder";
}
