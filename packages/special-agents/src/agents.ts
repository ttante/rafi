/**
 * Agent (role) manifest loader. Reads `content/agents/<role>.yaml` — the named
 * compositions of packs + skills that the runtime loads per turn-type. A pure
 * `parseAgentManifest` is split from the filesystem helpers.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type AgentManifest, type AgentRole, assertAgentManifest } from "rafi-spec";
import { CONTENT_DIR } from "./content.js";

/** Absolute path to the bundled `content/agents/` directory. */
export const AGENTS_DIR = join(CONTENT_DIR, "agents");

/** The roles Rafi ships, each mapping to an ai-foreman turn-type/command. */
export const AGENT_ROLES: AgentRole[] = ["builder", "qa", "planner", "ticket-maker", "uninstaller"];

/** Parse an agent-manifest YAML string into a validated AgentManifest. */
export function parseAgentManifest(raw: string): AgentManifest {
  const data = parseYaml(raw) as unknown;
  assertAgentManifest(data); // throws "Invalid agent manifest: …"
  return data;
}

/** Load a single role manifest by name (the file stem under content/agents). */
export function loadAgent(name: string): AgentManifest {
  const path = join(AGENTS_DIR, `${name}.yaml`);
  if (!existsSync(path)) throw new Error(`unknown agent: ${name}`);
  return parseAgentManifest(readFileSync(path, "utf8"));
}

/** Load every shipped role manifest (in {@link AGENT_ROLES} order). */
export function loadAllAgents(): AgentManifest[] {
  return AGENT_ROLES.map((role) => loadAgent(role));
}
