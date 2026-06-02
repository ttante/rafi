/**
 * Pack resolution — turns a role manifest's pack references into an ordered, deduped
 * list of concrete index entries.
 *
 * Reference forms (all `<category>/<name>` or `<category>/*`, matching the manifest
 * and index layout):
 *   - `base/core`     → the single pack with that category + name
 *   - `base/*`        → every pack in that category, in index order
 *
 * Resolution is decoupled from `ProjectConfig`: the caller maps project flags onto
 * the generic {@link ConditionFlags} (ai/frontend/cloud/backend) that gate the
 * manifest's `conditionalPacks`. Order follows appearance — listed packs first (globs
 * expanded in index order), then conditional groups in a fixed order — deduped by
 * first occurrence so authoring intent is preserved deterministically.
 */
import type { ConditionalPacks } from "rafi-spec";
import type { PackIndexEntry } from "./content.js";

/** Flags that gate `conditionalPacks`. The caller maps project flags onto these. */
export interface ConditionFlags {
  ai?: boolean;
  frontend?: boolean;
  cloud?: boolean;
  backend?: boolean;
}

export interface ResolveContext {
  /** Which conditional pack groups to include. */
  conditions: ConditionFlags;
  /** When true, packs marked `supersededByForeman` are dropped (foreman owns them). */
  foremanActive?: boolean;
}

/** Fixed order in which conditional groups are appended after the listed packs. */
const CONDITION_ORDER: (keyof ConditionalPacks)[] = ["ai", "frontend", "cloud", "backend"];

/** Resolve one ref (`cat/name` or `cat/*`) to its index entries. Throws if unresolved. */
function resolveOneRef(ref: string, index: PackIndexEntry[]): PackIndexEntry[] {
  const slash = ref.indexOf("/");
  if (slash === -1) throw new Error(`malformed pack ref (expected category/name): ${ref}`);
  const category = ref.slice(0, slash);
  const rest = ref.slice(slash + 1);

  if (rest === "*") {
    const matches = index.filter((e) => e.category === category);
    if (matches.length === 0) throw new Error(`no packs match glob: ${ref}`);
    return matches;
  }

  const match = index.find((e) => e.category === category && e.name === rest);
  if (!match) throw new Error(`unknown pack ref: ${ref}`);
  return [match];
}

/**
 * Expand and flatten a list of pack refs into ordered, deduped index entries.
 * Globs expand in index order; duplicates keep their first occurrence.
 */
export function resolvePackRefs(refs: string[], index: PackIndexEntry[]): PackIndexEntry[] {
  const out: PackIndexEntry[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    for (const entry of resolveOneRef(ref, index)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push(entry);
    }
  }
  return out;
}

/** A manifest's pack-bearing fields (the subset the resolver needs). */
export interface ResolvableManifest {
  packs: string[];
  conditionalPacks?: ConditionalPacks;
}

/**
 * Resolve a role's full pack set: listed `packs` first, then each enabled conditional
 * group (in {@link CONDITION_ORDER}), deduped by first occurrence. With
 * `foremanActive`, packs marked `supersededByForeman` are removed.
 */
export function resolveAgentPacks(
  manifest: ResolvableManifest,
  ctx: ResolveContext,
  index: PackIndexEntry[],
): PackIndexEntry[] {
  const refs = [...manifest.packs];
  const conditional = manifest.conditionalPacks ?? {};
  for (const key of CONDITION_ORDER) {
    if (ctx.conditions[key]) refs.push(...(conditional[key] ?? []));
  }

  let resolved = resolvePackRefs(refs, index);
  if (ctx.foremanActive) resolved = resolved.filter((e) => !e.supersededByForeman);
  return resolved;
}
