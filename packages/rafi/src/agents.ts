import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { parse, stringify } from "yaml";
import type { AgentDefaultsV1, AgentRoleDefaultsV1, ConfigurableAgentRole, ProjectConfig, ResolvedAgentSettings, SessionStrategy } from "rafi-spec";
import { validateAgentDefaults } from "rafi-spec";
import { AGENT_ROLE_REGISTRY } from "ai-foreman/roles.js";
import { probeRuntime } from "ai-foreman/runtime-readiness.js";
import { assertLifecycleForCommand } from "./lifecycle.js";
import {
  DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
  DEFAULT_COMPACT_MAXIMUM,
  normalizeProjectAgentDefaults,
  normalizeProjectConfig,
  RAFI_CONFIG_FILE,
} from "./project.js";
import { compile } from "./compiler.js";
import { WorkflowDb } from "ai-foreman/workflow-db.js";

export { AGENT_ROLE_REGISTRY };
export const CONFIGURABLE_ROLES = AGENT_ROLE_REGISTRY.filter((role) => role.configurable).map((role) => role.id);

export interface AgentCliOverrides {
  make?: "claude" | "codex";
  model?: string;
  reasoning?: string;
  fast?: boolean;
  session_strategy?: SessionStrategy;
  display_session_cost?: boolean;
  auto_compact_threshold_percent?: number;
  compact_maximum?: number;
}

export const DEFAULT_SESSION_STRATEGY: Readonly<Record<ConfigurableAgentRole, SessionStrategy>> = {
  builder: "compact",
  qa: "compact",
  "ticket-maker": "compact",
  planner: "fresh",
  uninstaller: "fresh",
};

export function defaultAgentDefaults(): AgentDefaultsV1 {
  return normalizeProjectAgentDefaults();
}

export function normalizeSessionStrategyDefaults(defaults?: AgentDefaultsV1): AgentDefaultsV1 {
  return normalizeProjectAgentDefaults(defaults);
}

export function formatSessionStrategyDefaults(defaults?: AgentDefaultsV1): string {
  const normalized = normalizeSessionStrategyDefaults(defaults);
  return CONFIGURABLE_ROLES
    .map((role) => `${role}: ${normalized.roles[role]?.session_strategy ?? DEFAULT_SESSION_STRATEGY[role]}`)
    .join(", ");
}

export async function promptSessionStrategyDefaults(defaults?: AgentDefaultsV1): Promise<{ defaults: AgentDefaultsV1; customized: boolean }> {
  const current = normalizeSessionStrategyDefaults(defaults);
  const { confirm, select, text, isCancel, log } = await import("@clack/prompts");
  log.info(`Agent session defaults: ${formatSessionStrategyDefaults(current)}`);
  const useDefaults = await confirm({
    message: "Use these compact/fresh defaults?",
    initialValue: true,
  });
  if (isCancel(useDefaults)) return { defaults: current, customized: false };

  const next = structuredClone(current);
  let customized = false;
  if (!useDefaults) {
    for (const role of CONFIGURABLE_ROLES) {
      const answer = await select({
        message: `${role} session continuity:`,
        initialValue: next.roles[role]?.session_strategy ?? DEFAULT_SESSION_STRATEGY[role],
        options: [
          { value: "compact", label: "Compact and continue" },
          { value: "fresh", label: "Fresh conversation" },
        ],
      });
      if (isCancel(answer)) return { defaults: current, customized: false };
      next.roles[role] = { ...next.roles[role], session_strategy: answer as SessionStrategy };
    }
    customized = true;
  }

  for (const role of ["builder", "qa"] as const) {
    const label = role === "builder" ? "Builder" : "QA";
    const thresholdCurrent = next.roles[role]?.auto_compact_threshold_percent ?? DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT;
    const thresholdChoice = await select({ message: `Automatically compact ${label} context at:`, options: [
      { value: "saved", label: `${thresholdCurrent}% (Recommended)` },
      { value: "custom", label: "Custom percentage" },
    ] });
    if (isCancel(thresholdChoice)) return { defaults: current, customized: false };
    let threshold = thresholdCurrent;
    if (thresholdChoice === "custom") {
      const answer = await text({ message: `${label} automatic compaction threshold (1-99):`, defaultValue: String(thresholdCurrent), validate: (value) => {
        const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 1 && parsed <= 99 ? undefined : "Enter an integer from 1 to 99";
      } });
      if (isCancel(answer)) return { defaults: current, customized: false };
      threshold = Number(answer); customized ||= threshold !== thresholdCurrent;
    }
    const maximumCurrent = next.roles[role]?.compact_maximum ?? DEFAULT_COMPACT_MAXIMUM;
    const maximumChoice = await select({ message: `Maximum successful compactions per ${label} provider session:`, options: [
      { value: "saved", label: `${maximumCurrent} (Recommended)` },
      { value: "custom", label: "Custom maximum" },
    ] });
    if (isCancel(maximumChoice)) return { defaults: current, customized: false };
    let maximum = maximumCurrent;
    if (maximumChoice === "custom") {
      const answer = await text({ message: `${label} compact maximum:`, defaultValue: String(maximumCurrent), validate: (value) => {
        const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? undefined : "Enter a positive safe integer";
      } });
      if (isCancel(answer)) return { defaults: current, customized: false };
      maximum = Number(answer); customized ||= maximum !== maximumCurrent;
    }
    next.roles[role] = { ...next.roles[role], auto_compact_threshold_percent: threshold, compact_maximum: maximum };
  }
  next.revision = customized ? (current.revision ?? 0) + 1 : current.revision;
  const validation = validateAgentDefaults(next);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  return { defaults: next, customized };
}

export function saveAgentDefaults(root: string, config: ProjectConfig, defaults: AgentDefaultsV1): ProjectConfig {
  const validation = validateAgentDefaults(defaults);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  const next = { ...config, agent_defaults: defaults };
  writeConfigAtomic(root, next);
  const workflow = new WorkflowDb(root);
  try { workflow.recordProjectSettingsRevision(defaults.revision ?? 0, defaults); } finally { workflow.close(); }
  compile(root, next, { skipDocs: true });
  return next;
}

export function resolveAgentSettings(input: {
  role: ConfigurableAgentRole;
  cli?: AgentCliOverrides;
  resumed?: AgentRoleDefaultsV1;
  project?: AgentDefaultsV1;
  manifest?: { model?: string | null; effort?: string | null };
  provider?: "claude" | "codex";
}): ResolvedAgentSettings {
  const candidates: Array<{ source: ResolvedAgentSettings["source"]; value?: AgentRoleDefaultsV1 }> = [
    { source: "cli", value: input.cli },
    { source: "resume", value: input.resumed },
    { source: "project", value: input.project?.roles[input.role] },
  ];
  const first = candidates.find((candidate) => candidate.value && Object.values(candidate.value).some((value) => value !== undefined));
  const pick = <K extends keyof AgentRoleDefaultsV1>(field: K): AgentRoleDefaultsV1[K] | undefined => {
    for (const candidate of candidates) if (candidate.value?.[field] !== undefined) return candidate.value[field];
    return undefined;
  };
  return {
    role: input.role,
    source: first?.source ?? (input.manifest?.model || input.manifest?.effort ? "manifest" : "provider"),
    make: pick("make") ?? input.provider ?? "claude",
    model: pick("model") ?? input.manifest?.model ?? "default",
    reasoning: pick("reasoning") ?? input.manifest?.effort ?? "default",
    fast: pick("fast") ?? false,
    session_strategy: pick("session_strategy") ?? DEFAULT_SESSION_STRATEGY[input.role],
    display_session_cost: pick("display_session_cost") ?? false,
    auto_compact_threshold_percent: pick("auto_compact_threshold_percent") ?? DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
    compact_maximum: pick("compact_maximum") ?? DEFAULT_COMPACT_MAXIMUM,
    settings_revision: input.project?.revision ?? 0,
  };
}

export function missingAgentFlags(opts: Record<string, unknown>): string[] {
  if (typeof opts.agentType !== "string" || !opts.agentType.trim()) return ["--agent-type"];
  const missing: string[] = [];
  if (opts.model === undefined) missing.push("--model");
  if (opts.reasoning === undefined) missing.push("--reasoning");
  return missing;
}

function missingAgentUpdateFlags(opts: Record<string, unknown>): string[] {
  if (typeof opts.agentType !== "string" || !opts.agentType.trim()) return ["--agent-type"];
  const settings = ["agentMake", "model", "reasoning", "fast", "sessionStrategy", "showSessionCost", "autoCompactThreshold", "compactMaximum"];
  return settings.some((key) => opts[key] !== undefined) ? [] : ["one setting flag"];
}

export function buildAgentsCommand(): Command {
  return new Command("agents")
    .description("Configure persistent runtime, model, reasoning, fast, and session defaults for Rafi roles.")
    .argument("[project]", "project directory", ".")
    .option("--agent-type <role>", "planner | builder | qa | ticket-maker | uninstaller | all")
    .option("--agent-make <runtime>", "claude | codex")
    .option("--model <model>", "provider model ID or default")
    .option("--reasoning <level>", "provider reasoning level or default")
    .option("--fast", "enable provider fast/speed capability")
    .option("--no-fast", "disable provider fast/speed capability")
    .option("--session-strategy <strategy>", "compact | fresh")
    .option("--show-session-cost", "show authoritative provider cost or cumulative session tokens")
    .option("--no-show-session-cost", "hide session cost/token usage")
    .option("--auto-compact-threshold <percent>", "Builder or QA context threshold (1-99 percent)")
    .option("--compact-maximum <count>", "Builder or QA successful compactions allowed per provider session")
    .action(async (project: string, opts: Record<string, unknown>) => {
      const root = resolve(project);
      const lifecycle = assertLifecycleForCommand(root, "agents");
      const anyFlags = ["agentType", "agentMake", "model", "reasoning", "fast", "sessionStrategy", "showSessionCost", "autoCompactThreshold", "compactMaximum"].some((key) => opts[key] !== undefined);
      let selected: ConfigurableAgentRole[];
      let settings: AgentRoleDefaultsV1;
      let promptedRoleSettings: Partial<Record<ConfigurableAgentRole, AgentRoleDefaultsV1>> | undefined;
      if (anyFlags) {
        const missing = missingAgentUpdateFlags(opts);
        if (missing.length) throw new Error(`partial agent configuration; missing: ${missing.join(", ")}`);
        selected = parseRoles(String(opts.agentType));
        settings = parseSettings(opts);
        if ((settings.auto_compact_threshold_percent !== undefined || settings.compact_maximum !== undefined) && (selected.length !== 1 || !["builder", "qa"].includes(selected[0]!))) {
          throw new Error("--auto-compact-threshold and --compact-maximum require --agent-type builder or qa");
        }
        if (settings.display_session_cost !== undefined && selected.some((role) => role !== "builder" && role !== "qa")) {
          throw new Error("session-cost display is configurable only for builder and qa");
        }
      } else {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("noninteractive use requires --agent-type and at least one setting flag");
        const prompted = await promptAgentSettings(root);
        selected = prompted.selected;
        settings = prompted.settings;
        promptedRoleSettings = prompted.roleSettings;
      }
      const config = readConfig(root);
      const defaults: AgentDefaultsV1 = structuredClone(config.agent_defaults ?? { version: 1, revision: 0, roles: {} });
      if (settings.make) {
        const readiness = await probeRuntime(root, settings.make, { phase: "capability-discovery" });
        if (!readiness.ok) throw new Error(`cannot save unsupported settings: ${readiness.diagnostics || readiness.category}`);
      }
      for (const role of selected) {
        const roleSettings = !anyFlags ? promptedRoleSettings?.[role] : undefined;
        defaults.roles[role] = { ...defaults.roles[role], ...settings, ...roleSettings };
      }
      defaults.revision = (defaults.revision ?? 0) + 1;
      const validation = validateAgentDefaults(defaults);
      if (!validation.valid) throw new Error(validation.errors.join("; "));
      saveAgentDefaults(root, config, defaults);
      console.log(`rafi agents: saved revision ${defaults.revision} for ${selected.join(", ")}`);
      const liveReport = await waitForLiveSettingsAcknowledgments(root, defaults.revision ?? 0, selected);
      for (const row of liveReport) {
        console.log(`rafi agents: run ${row.runId} ${row.role}${row.providerSessionId ? ` session ${row.providerSessionId}` : ""} — ${row.acknowledged ? `acknowledged revision ${row.revision}` : `did not acknowledge revision ${row.revision} within one heartbeat plus grace`}`);
      }
      if (settings.make && lifecycle.state !== "initialized") {
        console.log("rafi agents: runtime changes are saved but pending until initialization completes; explicit --agent flags still apply immediately.");
      }
    });
}

export interface LiveSettingsReportRow {
  runId: string;
  role: "builder" | "qa";
  providerSessionId?: string;
  revision: number;
  acknowledged: boolean;
}

/** Wait at most one 10-second build heartbeat plus five seconds of grace. */
export async function waitForLiveSettingsAcknowledgments(
  root: string,
  revision: number,
  selected: readonly ConfigurableAgentRole[],
  options: { waitMs?: number; pollMs?: number } = {},
): Promise<LiveSettingsReportRow[]> {
  const roles = selected.filter((role): role is "builder" | "qa" => role === "builder" || role === "qa");
  if (!roles.length) return [];
  const initialDb = new WorkflowDb(root);
  const active = initialDb.activeRuns().filter((run) => run.kind === "build");
  initialDb.close();
  if (!active.length) return [];
  const deadline = Date.now() + (options.waitMs ?? 15_000);
  let acknowledgments = new Map<string, ReturnType<WorkflowDb["settingsAcknowledgments"]>[number]>();
  while (Date.now() < deadline) {
    const db = new WorkflowDb(root);
    const current = db.settingsAcknowledgments(revision);
    db.close();
    acknowledgments = new Map(current.map((ack) => [`${ack.runId}:${ack.role}`, ack]));
    if (active.every((run) => roles.every((role) => acknowledgments.has(`${run.runId}:${role}`)))) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(options.pollMs ?? 250, Math.max(0, deadline - Date.now()))));
  }
  return active.flatMap((run) => roles.map((role): LiveSettingsReportRow => {
    const ack = acknowledgments.get(`${run.runId}:${role}`);
    return { runId: run.runId, role, ...(ack?.providerSessionId ? { providerSessionId: ack.providerSessionId } : {}), revision, acknowledged: Boolean(ack) };
  }));
}

async function promptAgentSettings(root: string): Promise<{ selected: ConfigurableAgentRole[]; settings: AgentRoleDefaultsV1; roleSettings?: Partial<Record<ConfigurableAgentRole, AgentRoleDefaultsV1>> }> {
  const { multiselect, select, confirm, text, isCancel } = await import("@clack/prompts");
  const roleAnswer = await multiselect({
    message: "Which roles should share these settings?",
    initialValues: [...CONFIGURABLE_ROLES],
    required: true,
    options: AGENT_ROLE_REGISTRY.map((role) => ({ value: role.id, label: role.label, hint: role.commands.join(", ") })),
  });
  if (isCancel(roleAnswer)) throw new Error("agent configuration cancelled; nothing was saved");
  const make = await select({ message: "Runtime:", options: [{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }] });
  if (isCancel(make)) throw new Error("agent configuration cancelled; nothing was saved");
  const model = await select({ message: "Model:", options: [{ value: "default", label: "Runtime default (Recommended)" }, { value: "custom", label: "Validated custom ID" }] });
  if (isCancel(model)) throw new Error("agent configuration cancelled; nothing was saved");
  let modelValue = String(model);
  if (model === "custom") {
    const { text } = await import("@clack/prompts");
    const custom = await text({ message: "Custom model ID:" });
    if (isCancel(custom) || !String(custom).trim()) throw new Error("agent configuration cancelled; nothing was saved");
    modelValue = String(custom).trim();
  }
  const reasoning = await select({ message: "Reasoning:", options: ["default", "low", "medium", "high", "xhigh"].map((value) => ({ value, label: value })) });
  if (isCancel(reasoning)) throw new Error("agent configuration cancelled; nothing was saved");
  const fast = await confirm({ message: "Enable fast mode when supported?", initialValue: false });
  if (isCancel(fast)) throw new Error("agent configuration cancelled; nothing was saved");
  const sessionStrategy = await select({ message: "Session continuity:", options: [
    { value: "compact", label: "Compact and continue (Recommended)" },
    { value: "fresh", label: "Fresh conversation with durable handoff" },
  ] });
  if (isCancel(sessionStrategy)) throw new Error("agent configuration cancelled; nothing was saved");
  const roleSettings: Partial<Record<ConfigurableAgentRole, AgentRoleDefaultsV1>> = {};
  const existing = readConfig(root).agent_defaults;
  for (const role of roleAnswer as ConfigurableAgentRole[]) {
    if (role !== "builder" && role !== "qa") continue;
    const label = role === "builder" ? "Builder" : "QA";
    const currentThreshold = existing?.roles[role]?.auto_compact_threshold_percent ?? DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT;
    const threshold = await text({
      message: `${label} automatic compaction threshold (1-99):`,
      defaultValue: String(currentThreshold),
      validate: (value) => {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= 1 && parsed <= 99 ? undefined : "Enter an integer from 1 to 99";
      },
    });
    if (isCancel(threshold)) throw new Error("agent configuration cancelled; nothing was saved");
    const currentMaximum = existing?.roles[role]?.compact_maximum ?? DEFAULT_COMPACT_MAXIMUM;
    const maximum = await text({
      message: `${label} maximum successful compactions per provider session:`,
      defaultValue: String(currentMaximum),
      validate: (value) => {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed > 0 ? undefined : "Enter a positive safe integer";
      },
    });
    if (isCancel(maximum)) throw new Error("agent configuration cancelled; nothing was saved");
    roleSettings[role] = { auto_compact_threshold_percent: Number(threshold), compact_maximum: Number(maximum) };
  }
  const ok = await confirm({ message: `Apply to ${(roleAnswer as string[]).join(", ")} in ${root}?`, initialValue: false });
  if (isCancel(ok) || !ok) throw new Error("agent configuration cancelled; nothing was saved");
  return {
    selected: roleAnswer as ConfigurableAgentRole[],
    settings: { make: make as "claude" | "codex", model: modelValue, reasoning: String(reasoning), fast: Boolean(fast), session_strategy: sessionStrategy as SessionStrategy },
    roleSettings,
  };
}

function parseRoles(value: string): ConfigurableAgentRole[] {
  if (value === "all") return [...CONFIGURABLE_ROLES];
  if (CONFIGURABLE_ROLES.includes(value as ConfigurableAgentRole)) return [value as ConfigurableAgentRole];
  throw new Error(`--agent-type must be one of: ${[...CONFIGURABLE_ROLES, "all"].join(", ")}`);
}

function parseSettings(opts: Record<string, unknown>): AgentRoleDefaultsV1 {
  const out: AgentRoleDefaultsV1 = {};
  if (opts.agentMake !== undefined) {
    const make = String(opts.agentMake);
    if (make !== "claude" && make !== "codex") throw new Error("--agent-make must be claude or codex");
    out.make = make;
  }
  if (opts.model !== undefined) out.model = String(opts.model);
  if (opts.reasoning !== undefined) out.reasoning = String(opts.reasoning);
  if (opts.fast !== undefined) out.fast = Boolean(opts.fast);
  if (opts.sessionStrategy !== undefined) {
    const strategy = String(opts.sessionStrategy);
    if (strategy !== "compact" && strategy !== "fresh") throw new Error("--session-strategy must be compact or fresh");
    out.session_strategy = strategy;
  }
  if (opts.showSessionCost !== undefined) out.display_session_cost = Boolean(opts.showSessionCost);
  if (opts.autoCompactThreshold !== undefined) {
    const value = Number(opts.autoCompactThreshold);
    if (!Number.isInteger(value) || value < 1 || value > 99) throw new Error("--auto-compact-threshold must be an integer from 1 to 99");
    out.auto_compact_threshold_percent = value;
  }
  if (opts.compactMaximum !== undefined) {
    const value = Number(opts.compactMaximum);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("--compact-maximum must be a positive safe integer");
    out.compact_maximum = value;
  }
  return out;
}

function readConfig(root: string): ProjectConfig {
  const path = join(root, RAFI_CONFIG_FILE);
  if (!existsSync(path)) throw new Error(`${RAFI_CONFIG_FILE} not found`);
  return normalizeProjectConfig(parse(readFileSync(path, "utf8")));
}

function writeConfigAtomic(root: string, config: ProjectConfig): void {
  const target = join(root, RAFI_CONFIG_FILE);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, stringify(config), "utf8");
  renameSync(temp, target);
}
