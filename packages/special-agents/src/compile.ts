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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { loadAgent, AGENT_ROLES } from "./agents.js";
import type { AgentManifest, AgentRole, EffortLevel } from "rafi-spec";

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

/**
 * Build the generated header comment that records which conditional pack groups
 * are active. Written at the top of `AGENTS.md` and `CLAUDE.md` so the choice
 * is never invisible.
 */
export function buildConditionsHeader(flags: {
  usesAI: boolean;
  hasFrontend: boolean;
  runsInCloud: boolean;
}): string {
  return (
    `# rafi: ai=${flags.usesAI ? "on" : "off"}` +
    ` frontend=${flags.hasFrontend ? "on" : "off"}` +
    ` cloud=${flags.runsInCloud ? "on" : "off"}\n`
  );
}

/**
 * Write `<targetDir>/AGENTS.md` — the flattened Codex rules document.
 * Format: one-line conditions header + preamble + all packs rendered with defaults.
 */
export function emitAgentsMd(targetDir: string, opts: CompileOptions = {}): void {
  const defaults = opts.defaults ?? loadDefaults();
  const header = buildConditionsHeader(defaults.flags as { usesAI: boolean; hasFrontend: boolean; runsInCloud: boolean });
  writeFileSync(join(targetDir, "AGENTS.md"), header + composeRulesMarkdown({ defaults }), "utf8");
}

/**
 * Write `<targetDir>/CLAUDE.md` — the lean Claude entrypoint that imports `AGENTS.md`.
 */
export function emitClaudeMd(targetDir: string, opts: CompileOptions = {}): void {
  const defaults = opts.defaults ?? loadDefaults();
  const header = buildConditionsHeader(defaults.flags as { usesAI: boolean; hasFrontend: boolean; runsInCloud: boolean });
  writeFileSync(join(targetDir, "CLAUDE.md"), header + "@AGENTS.md\n", "utf8");
}

export interface EmitOptions extends AgentComposeOptions {
  /** Roles to emit. Defaults to all four. */
  roles?: AgentRole[];
}

/**
 * Write `.rafi/compiled/<role>/system.md` + `meta.json` for each role.
 * Foreman's `roles.ts` reads these at runtime to load the composed bundle.
 */
export function emitCompiledBundles(targetDir: string, opts: EmitOptions = {}): void {
  const roles = opts.roles ?? AGENT_ROLES;
  for (const role of roles) {
    const bundle = getAgent(role, opts);
    const dir = join(targetDir, ".rafi", "compiled", role);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "system.md"), bundle.system, "utf8");
    const meta = { skills: bundle.skills, model: bundle.model, effort: bundle.effort };
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
  }
}

/**
 * Write lean Claude subagent files to `<targetDir>/.claude/agents/<role>.md`.
 * Each file has YAML front-matter (name, description) followed by the role's
 * composed system text.
 */
export function emitClaudeAgents(targetDir: string, opts: EmitOptions = {}): void {
  const roles = opts.roles ?? AGENT_ROLES;
  const agentsDir = join(targetDir, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const role of roles) {
    const bundle = getAgent(role, opts);
    const frontMatter = `---\nname: ${bundle.manifest.name}\ndescription: ${bundle.manifest.description}\n---\n\n`;
    writeFileSync(join(agentsDir, `${role}.md`), frontMatter + bundle.system, "utf8");
  }
}
