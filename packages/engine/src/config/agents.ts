// `rafi agents` on the engine side (CMD-16, FLAG-AG-1–6, FMT-C7; M5 plan C186): per-role settings saved under
// `agent_defaults.roles.<role>` through the one config writer, with `version: 1` and a revision bump; a key the org
// policy locks is refused (C184). Defaults aren't written: an unset session strategy reads as `fresh` for every role
// (builder, QA and ticket-maker included, Q-CFG-5).
import path from "node:path";
import { lookup, ROLE_NAMES, type RoleName } from "rafi-spec/v1";
import { parse } from "yaml";
import type { Deps, Fs } from "../deps/types.js";
import { withFileLock } from "../log/lock.js";
import { CONFIG_FILE } from "./load.js";
import { readPolicy } from "./policy.js";
import { editConfig, lockedEdit, lockedMessage, type SetEntry } from "./set.js";

export type RoleSettings = Partial<{ make: "claude" | "codex"; model: string; reasoning: string; fast: boolean;
  session_strategy: "compact" | "fresh"; display_session_cost: boolean; auto_compact_threshold_percent: number;
  compact_maximum: number }>;

export const COMPACTING_ROLES: readonly RoleName[] = ["builder", "qa"];
export { ROLE_NAMES };

export type AgentsSave = { ok: true; lines: string[] } | { ok: false; message: string };

async function savedRoles(fs: Fs, projectDir: string): Promise<{ revision: number;
  roles: Record<string, RoleSettings> }> {
  const config = parse(await fs.read(path.join(projectDir, CONFIG_FILE))) as Record<string, unknown>;
  return { revision: Number(lookup(config, "agent_defaults.revision") ?? 0),
    roles: (lookup(config, "agent_defaults.roles") ?? {}) as Record<string, RoleSettings> };
}

/** One line per role: what its next session uses, with the defaults filled in. */
export function describeRole(role: string, s: RoleSettings): string {
  return `${role}: runtime ${s.make ?? "default"}, model ${s.model ?? "runtime default"}, reasoning ${
    s.reasoning ?? "default"}, fast ${s.fast ? "on" : "off"}, session ${s.session_strategy ?? "fresh"}` +
    (s.auto_compact_threshold_percent ? `, compact at ${s.auto_compact_threshold_percent}%` : "") +
    (s.compact_maximum ? `, at most ${s.compact_maximum} compactions` : "");
}

/** Saves these settings for each role; nothing changes if any is locked or the result doesn't validate. */
export async function saveAgentSettings(deps: Deps, projectDir: string,
  changes: Readonly<Partial<Record<RoleName, RoleSettings>>>): Promise<AgentsSave> {
  const policy = await readPolicy(deps.fs, deps.machine.stateDir);
  if (!policy.ok) return policy;
  const edits: SetEntry[] = Object.entries(changes).flatMap(([role, s]) => Object.entries(s ?? {})
    .map(([field, value]) => ({ path: `agent_defaults.roles.${role}.${field}`, value })));
  const locked = lockedEdit(policy.locked, edits);
  if (locked) return { ok: false, message: lockedMessage(locked.path) };
  // R7: the revision is read and bumped under the file's lock, so two `rafi agents` at once both land.
  const written = await withFileLock(deps, projectDir, "rafi-config.yaml", async () => {
    const before = await savedRoles(deps.fs, projectDir);
    return editConfig(deps, projectDir, [{ path: "agent_defaults.version", value: 1 },
      { path: "agent_defaults.revision", value: before.revision + 1 }, ...edits]);
  });
  const saved = written.ok ? written.value : written;
  if (!saved.ok) return saved;
  const after = await savedRoles(deps.fs, projectDir);
  return { ok: true, lines: Object.keys(changes).map((role) => describeRole(role, after.roles[role] ?? {})) };
}

/** The saved settings of one role, for a walkthrough's current values. */
export async function roleSettingsOf(fs: Fs, projectDir: string, role: string): Promise<RoleSettings> {
  return (await savedRoles(fs, projectDir)).roles[role] ?? {};
}
