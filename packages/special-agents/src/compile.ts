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
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { loadAgent, AGENT_ROLES, AGENTS_DIR } from "./agents.js";
import { loadAllSkills, SKILLS_DIR } from "./skills.js";
import type { AgentManifest, AgentRole, EffortLevel } from "rafi-spec";

export const CUSTOM_ARTIFACTS_NOTE =
  "Custom Rafi skills or agents can replace the defaults by setting `artifact_source: existing` and editing their paths in `rafi-config.yaml`.\n";

export interface CompileOptions {
  /** Stack/flags to render with. Defaults to the bundled `defaults.yaml`. */
  defaults?: Defaults;
}

/** Render one pack body, substituting `{{vars}}` and resolving `{{#if flag}}` blocks. */
export function renderPackBody(pack: Pick<LoadedPack, "body">, defaults: Defaults): string {
  return render(pack.body, {
    vars: { ...defaults.stack, docsRoot: defaults.docsRoot ?? "docs" },
    flags: defaults.flags,
  });
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
  const roleAppendix = role === "manager"
    ? `\n${readFileSync(join(AGENTS_DIR, "manager-diagnostics.md"), "utf8")}`
    : "";
  return {
    manifest,
    system: composeAgentSystem(manifest, opts) + roleAppendix,
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
}, docsRoot = "docs"): string {
  return (
    `# rafi: ai=${flags.usesAI ? "on" : "off"}` +
    ` frontend=${flags.hasFrontend ? "on" : "off"}` +
    ` cloud=${flags.runsInCloud ? "on" : "off"}` +
    ` docs=${docsRoot}\n`
  );
}

/**
 * Write `<targetDir>/AGENTS.md` — the flattened Codex rules document.
 * Format: one-line conditions header + preamble + all packs rendered with defaults.
 */
export function emitAgentsMd(targetDir: string, opts: CompileOptions = {}): void {
  writeFileSync(join(targetDir, "AGENTS.md"), renderAgentsMd(opts), "utf8");
}

/**
 * Write `<targetDir>/CLAUDE.md` — the lean Claude entrypoint that imports `AGENTS.md`.
 */
export function emitClaudeMd(targetDir: string, opts: CompileOptions = {}): void {
  writeFileSync(join(targetDir, "CLAUDE.md"), renderClaudeMd(opts), "utf8");
}

export function renderAgentsMd(opts: CompileOptions = {}): string {
  const defaults = opts.defaults ?? loadDefaults();
  const header = buildConditionsHeader(
    defaults.flags as { usesAI: boolean; hasFrontend: boolean; runsInCloud: boolean },
    defaults.docsRoot ?? "docs",
  );
  return header + composeRulesMarkdown({ defaults });
}

export function renderClaudeMd(opts: CompileOptions = {}): string {
  const defaults = opts.defaults ?? loadDefaults();
  const header = buildConditionsHeader(
    defaults.flags as { usesAI: boolean; hasFrontend: boolean; runsInCloud: boolean },
    defaults.docsRoot ?? "docs",
  );
  return header + "@AGENTS.md\n\n" + CUSTOM_ARTIFACTS_NOTE;
}

export interface EmitOptions extends AgentComposeOptions {
  /** Roles to emit. Defaults to all four. */
  roles?: AgentRole[];
  /** Map generic skill names in role manifests to the installed runtime skill names. */
  skillNames?: Record<string, string>;
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
    const skills = bundle.skills.map((skill) => opts.skillNames?.[skill] ?? skill);
    const meta = { skills, model: bundle.model, effort: bundle.effort };
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

export interface EmitMappedOptions extends EmitOptions {
  paths?: Record<string, string>;
  force?: boolean;
}

export function emitMappedClaudeAgents(targetDir: string, opts: EmitMappedOptions = {}): void {
  const roles = opts.roles ?? AGENT_ROLES;
  for (const role of roles) {
    const bundle = getAgent(role, opts);
    const path = join(targetDir, opts.paths?.[role] ?? `./.claude/agents/${role}.md`);
    if (!opts.force && fileExists(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    const name = artifactNameFromPath(path, role);
    const frontMatter = `---\nname: ${name}\ndescription: ${bundle.manifest.description}\n---\n\n`;
    writeFileSync(path, frontMatter + bundle.system, "utf8");
  }
}

export function emitCodexAgents(targetDir: string, opts: EmitMappedOptions = {}): void {
  const roles = opts.roles ?? AGENT_ROLES;
  for (const role of roles) {
    const bundle = getAgent(role, opts);
    const path = join(targetDir, opts.paths?.[role] ?? `./.codex/agents/${role}.toml`);
    if (!opts.force && fileExists(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    const name = artifactNameFromPath(path, role);
    const toml =
      `name = ${JSON.stringify(name)}\n` +
      `description = ${JSON.stringify(bundle.manifest.description)}\n` +
      `developer_instructions = ${JSON.stringify(bundle.system)}\n`;
    writeFileSync(path, toml, "utf8");
  }
}

export interface EmitSkillsOptions {
  /** Generic skill name -> runtime-specific path. */
  paths?: Record<string, string>;
  names?: string[];
  force?: boolean;
}

export function emitSkills(targetDir: string, opts: EmitSkillsOptions = {}): void {
  for (const skill of loadAllSkills()) {
    if (opts.names && !opts.names.includes(skill.name)) continue;
    const path = join(targetDir, opts.paths?.[skill.name] ?? `./.agents/skills/${skill.name}/SKILL.md`);
    if (!opts.force && fileExists(path)) continue;
    const dir = dirname(path);
    mkdirSync(dirname(dir), { recursive: true });
    cpSync(join(SKILLS_DIR, skill.name), dir, { recursive: true });
    const installedName = artifactNameFromPath(path, skill.name);
    if (installedName !== skill.name) {
      const raw = readFileSync(join(SKILLS_DIR, skill.name, "SKILL.md"), "utf8");
      writeFileSync(path, raw.replace(/^name:\s*.+$/m, `name: ${installedName}`), "utf8");
    }
  }
}

function artifactNameFromPath(path: string, fallback: string): string {
  const file = path.split(/[\\/]/).pop() ?? fallback;
  if (file === "SKILL.md") {
    const parent = path.split(/[\\/]/).at(-2);
    return parent && parent.length > 0 ? parent : fallback;
  }
  return file.replace(/\.(md|toml)$/i, "") || fallback;
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
