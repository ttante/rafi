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
import { normalizeProjectConfig, RAFI_CONFIG_FILE } from "./project.js";
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
}

export const DEFAULT_SESSION_STRATEGY: Readonly<Record<ConfigurableAgentRole, SessionStrategy>> = {
  builder: "compact",
  qa: "compact",
  "ticket-maker": "compact",
  planner: "fresh",
  uninstaller: "fresh",
};

export function defaultAgentDefaults(): AgentDefaultsV1 {
  return {
    version: 1,
    revision: 0,
    roles: Object.fromEntries(CONFIGURABLE_ROLES.map((role) => [role, { session_strategy: DEFAULT_SESSION_STRATEGY[role] }])) as AgentDefaultsV1["roles"],
  };
}

export function normalizeSessionStrategyDefaults(defaults?: AgentDefaultsV1): AgentDefaultsV1 {
  const base = structuredClone(defaults ?? defaultAgentDefaults());
  base.version = 1;
  base.revision ??= 0;
  base.roles ??= {};
  for (const role of CONFIGURABLE_ROLES) {
    base.roles[role] = {
      ...base.roles[role],
      session_strategy: base.roles[role]?.session_strategy ?? DEFAULT_SESSION_STRATEGY[role],
    };
  }
  return base;
}

export function formatSessionStrategyDefaults(defaults?: AgentDefaultsV1): string {
  const normalized = normalizeSessionStrategyDefaults(defaults);
  return CONFIGURABLE_ROLES
    .map((role) => `${role}: ${normalized.roles[role]?.session_strategy ?? DEFAULT_SESSION_STRATEGY[role]}`)
    .join(", ");
}

export async function promptSessionStrategyDefaults(defaults?: AgentDefaultsV1): Promise<{ defaults: AgentDefaultsV1; customized: boolean }> {
  const current = normalizeSessionStrategyDefaults(defaults);
  const { confirm, select, isCancel, log } = await import("@clack/prompts");
  log.info(`Agent session defaults: ${formatSessionStrategyDefaults(current)}`);
  const useDefaults = await confirm({
    message: "Use these compact/fresh defaults?",
    initialValue: true,
  });
  if (isCancel(useDefaults) || useDefaults) return { defaults: current, customized: false };

  const next = structuredClone(current);
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
  next.revision = (current.revision ?? 0) + 1;
  const validation = validateAgentDefaults(next);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  return { defaults: next, customized: true };
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
  const settings = ["agentMake", "model", "reasoning", "fast", "sessionStrategy"];
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
    .action(async (project: string, opts: Record<string, unknown>) => {
      const root = resolve(project);
      assertLifecycleForCommand(root, "agents");
      const anyFlags = ["agentType", "agentMake", "model", "reasoning", "fast", "sessionStrategy"].some((key) => opts[key] !== undefined);
      let selected: ConfigurableAgentRole[];
      let settings: AgentRoleDefaultsV1;
      if (anyFlags) {
        const missing = missingAgentUpdateFlags(opts);
        if (missing.length) throw new Error(`partial agent configuration; missing: ${missing.join(", ")}`);
        selected = parseRoles(String(opts.agentType));
        settings = parseSettings(opts);
      } else {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("noninteractive use requires --agent-type and at least one setting flag");
        ({ selected, settings } = await promptAgentSettings(root));
      }
      const config = readConfig(root);
      const defaults: AgentDefaultsV1 = structuredClone(config.agent_defaults ?? { version: 1, revision: 0, roles: {} });
      if (settings.make) {
        const readiness = await probeRuntime(root, settings.make, { phase: "capability-discovery" });
        if (!readiness.ok) throw new Error(`cannot save unsupported settings: ${readiness.diagnostics || readiness.category}`);
      }
      for (const role of selected) defaults.roles[role] = { ...defaults.roles[role], ...settings };
      defaults.revision = (defaults.revision ?? 0) + 1;
      const validation = validateAgentDefaults(defaults);
      if (!validation.valid) throw new Error(validation.errors.join("; "));
      saveAgentDefaults(root, config, defaults);
      console.log(`rafi agents: saved revision ${defaults.revision} for ${selected.join(", ")}`);
    });
}

async function promptAgentSettings(root: string): Promise<{ selected: ConfigurableAgentRole[]; settings: AgentRoleDefaultsV1 }> {
  const { multiselect, select, confirm, isCancel } = await import("@clack/prompts");
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
  const ok = await confirm({ message: `Apply to ${(roleAnswer as string[]).join(", ")} in ${root}?`, initialValue: false });
  if (isCancel(ok) || !ok) throw new Error("agent configuration cancelled; nothing was saved");
  return { selected: roleAnswer as ConfigurableAgentRole[], settings: { make: make as "claude" | "codex", model: modelValue, reasoning: String(reasoning), fast: Boolean(fast), session_strategy: sessionStrategy as SessionStrategy } };
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
