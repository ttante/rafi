/**
 * 3-tier role bundle loader. Returns the composed system text + metadata for a
 * given role, trying each tier in order:
 *
 *   1. `.rafi/compiled/<role>/` in the target repo — written by `rafi compile`.
 *   2. Library defaults from `special-agents` — the prebuilt default bundle.
 *   3. Hardcoded fallback — empty system text, no skills (today's behavior).
 *
 * `libraryGetAgent` can be injected for tests; pass `null` to force tier 3.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgent } from "special-agents";
import type { ConfigurableAgentRole } from "rafi-spec";

export interface AgentRoleRegistration {
  id: ConfigurableAgentRole;
  label: string;
  consumers: string[];
  configurable: boolean;
  manifest: string;
  commands: string[];
}

/** One registry drives compilation, settings UI, and independently launched roles. */
export const AGENT_ROLE_REGISTRY: readonly AgentRoleRegistration[] = [
  { id: "planner", label: "Planner", consumers: ["initial planning", "ticket planning"], configurable: true, manifest: "planner", commands: ["rafi create", "rafi plan", "rafi tickets plan"] },
  { id: "builder", label: "Builder", consumers: ["implementation"], configurable: true, manifest: "builder", commands: ["rafi start", "rafi build:resume"] },
  { id: "qa", label: "QA (separate review session)", consumers: ["run-wide independent review"], configurable: true, manifest: "qa", commands: ["rafi start", "rafi build:resume"] },
  { id: "ticket-maker", label: "Ticket maker", consumers: ["ticket population"], configurable: true, manifest: "ticket-maker", commands: ["rafi tickets populate"] },
  { id: "uninstaller", label: "Uninstaller", consumers: ["non-empty uninstall instructions only"], configurable: true, manifest: "uninstaller", commands: ["rafi uninstall"] },
  { id: "manager", label: "Manager (read-only diagnostics)", consumers: ["build diagnostics"], configurable: true, manifest: "manager", commands: ["rafi manager", "ai-foreman manager"] },
] as const;

export interface RoleBundle {
  system: string;
  skills: string[];
  model: string | null;
  effort: string | null;
  /** Which tier provided this bundle. */
  source: "compiled" | "library" | "fallback";
}

export type LibraryGetAgent = (
  role: string,
) => { system: string; skills: string[]; model: string | null; effort: string | null };

export interface LoadRoleBundleOpts {
  /** Target repo root — checked for `.rafi/compiled/<role>/`. */
  projectDir?: string;
  /**
   * Override the library getter. Omit to use the real `special-agents` library.
   * Pass `null` to simulate the library being absent (forces tier 3).
   */
  libraryGetAgent?: LibraryGetAgent | null;
}

function libraryGetter(role: string) {
  const a = getAgent(role);
  return { system: a.system, skills: a.skills, model: a.model, effort: a.effort };
}

export function loadRoleBundle(role: string, opts: LoadRoleBundleOpts = {}): RoleBundle {
  // Tier 1: compiled bundle in the target repo
  if (opts.projectDir) {
    const base = join(opts.projectDir, ".rafi", "compiled", role);
    const sysPath = join(base, "system.md");
    const metaPath = join(base, "meta.json");
    if (existsSync(sysPath) && existsSync(metaPath)) {
      const system = readFileSync(sysPath, "utf8");
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
        skills?: string[];
        model?: string | null;
        effort?: string | null;
      };
      return {
        system,
        skills: meta.skills ?? [],
        model: meta.model ?? null,
        effort: meta.effort ?? null,
        source: "compiled",
      };
    }
  }

  // Tier 2: library defaults (special-agents)
  const getter = opts.libraryGetAgent !== undefined ? opts.libraryGetAgent : libraryGetter;
  if (getter !== null) {
    try {
      const b = getter(role);
      return { ...b, source: "library" };
    } catch {
      // fall through to tier 3
    }
  }

  // Tier 3: hardcoded fallback — preserves behavior from before Phase 5
  return { system: "", skills: [], model: null, effort: null, source: "fallback" };
}
