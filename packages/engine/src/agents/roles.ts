// The agent per role (C34): runtime, model, effort and fast from the flags, the role's project settings or the
// defaults, each with its source; and C52's check that a configured model is one the provider lists.
import path from "node:path";
import type { Settings } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import { agentEnv } from "../build/env.js";
import type { RoleAgent } from "../build/context.js";
import { checkModel } from "./capabilities.js";
import { claudeAgent } from "./claude/adapter.js";
import { codexAgent } from "./codex/adapter.js";
import { findOnPath } from "./readiness.js";

export type Roles = Record<"builder" | "qa", RoleAgent>;

export async function roleAgents(settings: Settings, deps: Engine["deps"]): Promise<{ roles: Roles; extra: Settings }> {
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
export async function modelFlag(engine: Engine, roles: Roles, role: "builder" | "qa", agentsEnv: readonly string[]):
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
