/**
 * Composition — assembles harness artifacts from the bundled packs.
 *
 * `composeRulesMarkdown` produces the flattened rules document (Codex's `AGENTS.md`
 * form): the preamble followed by every pack in index order, with templated packs
 * rendered against the stack/flags. Because each pack body is a contiguous slice of
 * the source between headings, concatenating them after the preamble reproduces the
 * canonical rules doc byte-for-byte — the Phase 3 golden gate.
 *
 * Per-role and lean-Claude emission build on this and the resolver (see resolve.ts).
 */
import { render } from "./template.js";
import {
  loadAllPacks,
  loadDefaults,
  loadPack,
  loadPacksIndex,
  loadPreamble,
  type Defaults,
  type LoadedPack,
} from "./content.js";
import { resolveAgentPacks, type ConditionFlags, type ResolvableManifest } from "./resolve.js";
import { loadAgent } from "./agents.js";
import type { AgentManifest, EffortLevel } from "rafi-spec";

export interface CompileOptions {
  /** Stack/flags to render with. Defaults to the bundled `defaults.yaml`. */
  defaults?: Defaults;
}

/** Render one pack body, substituting `{{vars}}` and resolving `{{#if flag}}` blocks. */
export function renderPackBody(pack: Pick<LoadedPack, "body">, defaults: Defaults): string {
  return render(pack.body, { vars: defaults.stack, flags: defaults.flags });
}

/**
 * The full flattened rules doc: preamble + all packs (index order), rendered.
 * Includes every pack regardless of condition — this is the canonical "everything"
 * document; role/flag filtering is the resolver's job.
 */
export function composeRulesMarkdown(opts: CompileOptions = {}): string {
  const defaults = opts.defaults ?? loadDefaults();
  const body = loadAllPacks()
    .map((pack) => renderPackBody(pack, defaults))
    .join("");
  return loadPreamble() + body;
}

/** Options controlling how a role's packs are resolved and rendered. */
export interface AgentComposeOptions {
  /** Stack/flags to render with. Defaults to the bundled `defaults.yaml`. */
  defaults?: Defaults;
  /** Which conditional pack groups to include (ai/frontend/cloud/backend). */
  conditions?: ConditionFlags;
  /** Drop `supersededByForeman` packs (the foreman tracker owns them). */
  foremanActive?: boolean;
}

/**
 * Render a role's system text: its resolved packs (listed + enabled conditionals,
 * deduped, in manifest order) concatenated and rendered with the defaults. Unlike
 * {@link composeRulesMarkdown} there is no preamble — this is appended to the
 * harness's own system prompt, not used as a standalone rules doc.
 */
export function composeAgentSystem(
  manifest: ResolvableManifest,
  opts: AgentComposeOptions = {},
): string {
  const defaults = opts.defaults ?? loadDefaults();
  const index = loadPacksIndex();
  const entries = resolveAgentPacks(
    manifest,
    { conditions: opts.conditions ?? {}, foremanActive: opts.foremanActive },
    index,
  );
  return entries.map((e) => renderPackBody(loadPack(e.path), defaults)).join("");
}

/** A composed role bundle, ready for the runtime to load. */
export interface ComposedAgent {
  manifest: AgentManifest;
  /** The rendered role system text (pack bodies). */
  system: string;
  /** Skill names the role preloads. */
  skills: string[];
  /** Model override, or null to inherit the runtime's `--model`. */
  model: string | null;
  /** Effort override, or null to inherit the runtime's `--effort`. */
  effort: EffortLevel | null;
}

/** Load a role manifest and compose its full bundle (system text + metadata). */
export function getAgent(role: string, opts: AgentComposeOptions = {}): ComposedAgent {
  const manifest = loadAgent(role);
  return {
    manifest,
    system: composeAgentSystem(manifest, opts),
    skills: manifest.skills,
    model: manifest.model ?? null,
    effort: manifest.effort ?? null,
  };
}
