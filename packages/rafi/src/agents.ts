import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { parse, stringify } from "yaml";
import type { AgentDefaultsV1, AgentRoleDefaultsV1, ConfigurableAgentRole, ProjectConfig, ResolvedAgentSettings } from "rafi-spec";
import { validateAgentDefaults } from "rafi-spec";
import { AGENT_ROLE_REGISTRY } from "ai-foreman/roles.js";
import { probeRuntime } from "ai-foreman/runtime-readiness.js";
import { assertLifecycleForCommand } from "./lifecycle.js";
import { normalizeProjectConfig, RAFI_CONFIG_FILE } from "./project.js";
import { compile } from "./compiler.js";

export { AGENT_ROLE_REGISTRY };
export const CONFIGURABLE_ROLES = AGENT_ROLE_REGISTRY.filter((role) => role.configurable).map((role) => role.id);

export interface AgentCliOverrides {
  make?: "claude" | "codex";
  model?: string;
  reasoning?: string;
  fast?: boolean;
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
    { source: "cli", value: complete(input.cli) ? input.cli as AgentRoleDefaultsV1 : undefined },
    { source: "resume", value: input.resumed },
    { source: "project", value: input.project?.roles[input.role] },
  ];
  for (const candidate of candidates) if (candidate.value) return { role: input.role, source: candidate.source, ...candidate.value };
  if (input.manifest?.model || input.manifest?.effort) return {
    role: input.role, source: "manifest", make: input.provider ?? "claude",
    model: input.manifest.model ?? "default", reasoning: input.manifest.effort ?? "default", fast: false,
  };
  return { role: input.role, source: "provider", make: input.provider ?? "claude", model: "default", reasoning: "default", fast: false };
}

export function missingAgentFlags(opts: Record<string, unknown>): string[] {
  return ["agentType", "agentMake", "model", "reasoning"]
    .filter((key) => typeof opts[key] !== "string" || !(opts[key] as string).trim())
    .map((key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
}

export function buildAgentsCommand(): Command {
  return new Command("agents")
    .description("Configure persistent runtime, model, reasoning, and fast defaults for Rafi roles.")
    .argument("[project]", "project directory", ".")
    .option("--agent-type <role>", "planner | builder | qa | ticket-maker | uninstaller | all")
    .option("--agent-make <runtime>", "claude | codex")
    .option("--model <model>", "provider model ID or default")
    .option("--reasoning <level>", "provider reasoning level or default")
    .option("--fast", "enable provider fast/speed capability")
    .action(async (project: string, opts: Record<string, unknown>) => {
      const root = resolve(project);
      assertLifecycleForCommand(root, "agents");
      const anyFlags = ["agentType", "agentMake", "model", "reasoning", "fast"].some((key) => opts[key] !== undefined);
      let selected: ConfigurableAgentRole[];
      let settings: AgentRoleDefaultsV1;
      if (anyFlags) {
        const missing = missingAgentFlags(opts);
        if (missing.length) throw new Error(`partial agent configuration; missing: ${missing.join(", ")}`);
        selected = parseRoles(String(opts.agentType));
        settings = parseSettings(opts);
      } else {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("noninteractive use requires --agent-type, --agent-make, --model, and --reasoning");
        ({ selected, settings } = await promptAgentSettings(root));
      }
      const readiness = await probeRuntime(root, settings.make, { phase: "capability-discovery" });
      if (!readiness.ok) throw new Error(`cannot save unsupported settings: ${readiness.diagnostics || readiness.category}`);
      const config = readConfig(root);
      const defaults: AgentDefaultsV1 = config.agent_defaults ?? { version: 1, roles: {} };
      for (const role of selected) defaults.roles[role] = { ...settings };
      const validation = validateAgentDefaults(defaults);
      if (!validation.valid) throw new Error(validation.errors.join("; "));
      const next = { ...config, agent_defaults: defaults };
      writeConfigAtomic(root, next);
      compile(root, next, { skipDocs: true });
      console.log(`rafi agents: saved ${selected.join(", ")} (${settings.make}, ${settings.model}, ${settings.reasoning}, fast=${settings.fast})`);
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
  const ok = await confirm({ message: `Apply to ${(roleAnswer as string[]).join(", ")} in ${root}?`, initialValue: false });
  if (isCancel(ok) || !ok) throw new Error("agent configuration cancelled; nothing was saved");
  return { selected: roleAnswer as ConfigurableAgentRole[], settings: { make: make as "claude" | "codex", model: modelValue, reasoning: String(reasoning), fast: Boolean(fast) } };
}

function parseRoles(value: string): ConfigurableAgentRole[] {
  if (value === "all") return [...CONFIGURABLE_ROLES];
  if (CONFIGURABLE_ROLES.includes(value as ConfigurableAgentRole)) return [value as ConfigurableAgentRole];
  throw new Error(`--agent-type must be one of: ${[...CONFIGURABLE_ROLES, "all"].join(", ")}`);
}

function parseSettings(opts: Record<string, unknown>): AgentRoleDefaultsV1 {
  const make = String(opts.agentMake);
  if (make !== "claude" && make !== "codex") throw new Error("--agent-make must be claude or codex");
  return { make, model: String(opts.model), reasoning: String(opts.reasoning), fast: Boolean(opts.fast) };
}

function complete(value: AgentCliOverrides | undefined): boolean {
  return Boolean(value?.make && value.model && value.reasoning && value.fast !== undefined);
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
