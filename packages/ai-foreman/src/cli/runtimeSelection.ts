import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentRuntime } from "../runtimeAuth.js";

export const VALID_AGENTS = ["claude", "codex"] as const;

export function isAgentRuntime(value: string): value is AgentRuntime {
  return (VALID_AGENTS as readonly string[]).includes(value);
}

export function validateAgentRuntime(value: string): AgentRuntime {
  if (isAgentRuntime(value)) return value;
  throw new Error(`unknown agent "${value}" - choose: ${VALID_AGENTS.join(" | ")}`);
}

export function otherRuntime(runtime: AgentRuntime): AgentRuntime {
  return runtime === "claude" ? "codex" : "claude";
}

export function runtimeDisplayName(runtime: AgentRuntime): string {
  return runtime === "claude" ? "Claude" : "Codex";
}

export function defaultAgentForProject(projectDir: string): AgentRuntime {
  const targets = readRafiRuntimeTargets(projectDir);
  return targets?.length === 1 ? targets[0] : "claude";
}

export function resolveAgentForProject(projectDir: string, explicitAgent?: string): AgentRuntime {
  if (explicitAgent !== undefined) return validateAgentRuntime(explicitAgent);
  return defaultAgentForProject(projectDir);
}

export function readRafiRuntimeTargets(projectDir: string): AgentRuntime[] | undefined {
  const configPath = join(projectDir, "rafi-config.yaml");
  if (!existsSync(configPath)) return undefined;
  try {
    const raw = parseYaml(readFileSync(configPath, "utf8")) as {
      harness?: { targets?: unknown };
    } | null;
    const targets = raw?.harness?.targets;
    if (!Array.isArray(targets)) return undefined;
    const out: AgentRuntime[] = [];
    for (const target of targets) {
      if ((target === "claude" || target === "codex") && !out.includes(target)) {
        out.push(target);
      }
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
