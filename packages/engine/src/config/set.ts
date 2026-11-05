// `--set key=value` (ARCH 8.6; M5 plan C183) and the one writer of rafi-config.yaml (C187). A `--set` value is a
// YAML scalar or flow value, checked against its key's type once the layers merge; it's for one build and never
// written. Rafi's own edits (`rafi agents`, `tickets setup:*`) go through `editConfig`: the yaml Document API keeps
// comments and every other key, the result is validated before it's written, and the write is an atomic rename
// that's redone from the new text if the file changed while the edit was made.
import path from "node:path";
import { checkConfigV1, isSection, keyFor } from "rafi-spec/v1";
import { isMap, parse, parseDocument } from "yaml";
import { boundary } from "../deps/hooks.js";
import type { Deps, Fs, Hooks } from "../deps/types.js";
import { withFileLock } from "../log/lock.js";
import { CONFIG_FILE } from "./load.js";
import { POLICY_SHOWN, readPolicy } from "./policy.js";

export interface SetEntry { readonly path: string; readonly value: unknown }
export type SetParse = { ok: true; sets: SetEntry[] } | { ok: false; message: string };

export function parseSets(entries: readonly string[]): SetParse {
  const sets: SetEntry[] = [];
  for (const entry of entries) {
    const at = entry.indexOf("=");
    const key = at > 0 ? entry.slice(0, at).trim() : "";
    if (!key || !/^[A-Za-z0-9_.-]+$/.test(key)) {
      return { ok: false, message: `--set takes key=value, with the key a rafi-config.yaml dot path (got ${
        JSON.stringify(entry.slice(0, 80))}).` };
    }
    if (!keyFor(key)) {
      return { ok: false, message: isSection(key) ? `--set ${key}: that's a section; name one of its keys.`
        : `--set ${key}: unknown key.` };
    }
    let value: unknown;
    try {
      value = parse(entry.slice(at + 1), { maxAliasCount: 0 });
    } catch {
      return { ok: false, message: `--set ${key}: the value isn't a YAML scalar or flow value.` };
    }
    sets.push({ path: key, value: value ?? null });
  }
  return { ok: true, sets };
}

/** Sets a dot path inside a plain object, copying each level it passes through. */
export function setPath(target: Record<string, unknown>, parts: readonly string[], value: unknown):
  Record<string, unknown> {
  const [head, ...rest] = parts;
  const out = { ...target };
  if (!rest.length) { out[head!] = value; return out; }
  const inner = out[head!];
  out[head!] = setPath(inner && typeof inner === "object" && !Array.isArray(inner)
    ? inner as Record<string, unknown> : {}, rest, value);
  return out;
}

export type ConfigEdit = { ok: true } | { ok: false; message: string };

/** The first edit whose path an org-locked key covers (the key itself, inside it, or a section holding it). */
export function lockedEdit(locked: Readonly<Record<string, unknown>>, edits: readonly SetEntry[]): SetEntry | null {
  return edits.find((e) => Object.keys(locked).some((l) => e.path === l || e.path.startsWith(`${l}.`) ||
    l.startsWith(`${e.path}.`))) ?? null;
}

export const lockedMessage = (p: string) => `${p} is locked by your organization's policy (${POLICY_SHOWN}).`;

/** Applies these dot-path edits to rafi-config.yaml, keeping comments; refused (file unchanged) if the result
 * doesn't validate. Re-reads and redoes the edit if the file changed between the read and the write (R7).
 * Part 6 (M5 review P2): every writer of the file comes through here, so the org policy is checked here: a damaged
 * policy, or an edit of a locked key, is refused with `rafi agents`'s message and nothing is written. */
export async function editConfig(deps: { fs: Fs; hooks?: Hooks; machine: { stateDir: string } }, projectDir: string,
  edits: readonly SetEntry[]): Promise<ConfigEdit> {
  const policy = await readPolicy(deps.fs, deps.machine.stateDir);
  if (!policy.ok) return policy;
  const locked = lockedEdit(policy.locked, edits);
  if (locked) return { ok: false, message: lockedMessage(locked.path) };
  const file = path.join(projectDir, CONFIG_FILE);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = await deps.fs.read(file);
    const doc = parseDocument(before);
    if (doc.errors.length || !isMap(doc.contents)) return { ok: false, message: `${CONFIG_FILE} isn't valid YAML.` };
    for (const edit of edits) doc.setIn(edit.path.split("."), edit.value);
    const checked = checkConfigV1(doc.toJS());
    if (!checked.ok) return { ok: false, message: checked.message };
    if ((await deps.fs.read(file)) !== before) continue;
    if (deps.hooks) await boundary(deps.hooks, "7: before the rafi-config.yaml rename");
    await deps.fs.writeAtomic(file, doc.toString());
    return { ok: true };
  }
  return { ok: false, message: `${CONFIG_FILE} kept changing while rafi edited it; try again.` };
}

/** C187, R7: rafi's one writer of rafi-config.yaml (`rafi agents`, `tickets setup:*`): editConfig under the file's
 * lock, so two rafi commands editing it at once both land. */
export async function saveConfig(deps: Deps, projectDir: string, edits: readonly SetEntry[]): Promise<ConfigEdit> {
  const locked = await withFileLock(deps, projectDir, "rafi-config.yaml", () => editConfig(deps, projectDir, edits));
  return locked.ok ? locked.value : locked;
}
