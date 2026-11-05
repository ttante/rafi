// Rule packs and skills by tag (ARCH 10.1, 10.2; M5 plan C220, C221). The content is special-agents' data, read
// through deps.fs: `content/tags.yaml` (the fixed tag list), `content/rules/packs.index.yaml` (each pack's `tags:`,
// beside the `condition:` today's engine still reads), the pack files, `content/skills/skills.index.yaml` and each
// skill's front matter, and the role manifests' `skills:`. A pack reaches a session when one of its tags is among
// the ticket's, or it's tagged `always` (the small core); `condition:` and `conditionalPacks` are ignored here.
// Skills go by name and description only, with the file's path, so an agent opens one when it needs it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Settings } from "rafi-spec/v1";
import type { Fs } from "../deps/types.js";
import { toolsFor } from "../tools/registry.js";
import type { TicketContext } from "./assemble.js";
import type { TagPatterns } from "./tags.js";

export interface PackEntry { readonly name: string; readonly path: string; readonly tags: readonly string[];
  readonly template: boolean; readonly order: number }
export interface SkillEntry { readonly name: string; readonly description: string; readonly path: string }

export interface Content {
  readonly dir: string;
  readonly tags: readonly { name: string; description: string; patterns: string[] }[];
  readonly packs: readonly PackEntry[];
  readonly skills: readonly (SkillEntry & { tags: readonly string[] })[];
  readonly roles: Readonly<Record<string, readonly string[]>>;
  readonly defaults: { stack: Record<string, string>; flags: Record<string, boolean> };
}

/** special-agents' bundled `content/` folder, beside its `dist/` (it ships both). */
export function contentDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.resolve("special-agents"))), "..", "content");
}

const yamlAt = async (fs: Fs, file: string) => parse(await fs.read(file), { maxAliasCount: 0 }) as unknown;
const FRONT = /^---\n([\s\S]*?)\n---\n?/;

/** The fixed tag list, name → default patterns, in the file's order. */
export async function fixedTags(fs: Fs, dir = contentDir()): Promise<TagPatterns> {
  const list = (await yamlAt(fs, path.join(dir, "tags.yaml")) as { tags: { name: string; patterns?: string[] }[] })
    .tags;
  return Object.fromEntries(list.map((t) => [t.name, [...(t.patterns ?? [])]]));
}

export async function loadContent(fs: Fs, dir = contentDir()): Promise<Content> {
  const tags = (await yamlAt(fs, path.join(dir, "tags.yaml")) as { tags: Content["tags"] }).tags;
  const packs = ((await yamlAt(fs, path.join(dir, "rules", "packs.index.yaml")) as { packs: PackEntry[] }).packs)
    .filter((p) => Array.isArray(p.tags)).sort((a, b) => a.order - b.order);
  const index = (await yamlAt(fs, path.join(dir, "skills", "skills.index.yaml")) as
    { skills: { name: string; tags: string[] }[] }).skills;
  const skills = [];
  for (const s of index) {
    const file = path.join(dir, "skills", s.name, "SKILL.md");
    const front = FRONT.exec(await fs.read(file));
    const meta = (front ? parse(front[1]!) : {}) as { description?: string };
    skills.push({ name: s.name, description: String(meta.description ?? ""), path: file, tags: s.tags });
  }
  const roles: Record<string, string[]> = {};
  for (const role of ["builder", "qa"]) {
    roles[role] = ((await yamlAt(fs, path.join(dir, "agents", `${role}.yaml`))) as { skills?: string[] })
      .skills ?? [];
  }
  const defaults = (await yamlAt(fs, path.join(dir, "defaults.yaml"))) as Content["defaults"];
  return { dir, tags, packs, skills, roles, defaults };
}

const picks = (tags: readonly string[], ticket: ReadonlySet<string>) =>
  tags.includes("always") || tags.some((t) => ticket.has(t));

/** The packs a ticket with these tags gets, in index order, each once. */
export function packsFor(content: Content, tags: ReadonlySet<string>): PackEntry[] {
  return content.packs.filter((p) => picks(p.tags, tags));
}

/** The role's skills a ticket with these tags gets: name, description and path only. */
export function skillsFor(content: Content, role: string, tags: ReadonlySet<string>): SkillEntry[] {
  const own = content.roles[role] ?? [];
  return content.skills.filter((s) => own.includes(s.name) && picks(s.tags, tags))
    .map((s) => ({ name: s.name, description: s.description, path: s.path }));
}

/** special-agents' two template directives (`{{key}}`, `{{#if flag}}…{{/if}}`), with its defaults under the
 * project's `stack` and `flags`; the docs folder from `docs.root`. */
function render(body: string, vars: Record<string, string>, flags: Record<string, boolean>): string {
  return body.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, f: string, b: string) => (flags[f] ? b : ""))
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
}

export async function packTexts(fs: Fs, content: Content, packs: readonly PackEntry[],
  o: { stack?: Record<string, string>; flags?: Record<string, boolean>; docsRoot?: string }): Promise<string[]> {
  const vars = { ...content.defaults.stack, ...(o.stack ?? {}), docsRoot: o.docsRoot ?? "docs" };
  const flags = { ...content.defaults.flags, ...(o.flags ?? {}) };
  const out: string[] = [];
  for (const p of packs) {
    const body = (await fs.read(path.join(content.dir, "rules", p.path))).replace(FRONT, "").trim();
    out.push(p.template ? render(body, vars, flags) : body);
  }
  return out;
}

/** What a ticket's tags give one role's session (sections 2–4), with the pack names, from the settings' `stack`,
 * `flags`, `docs.root` and `tools`. */
export async function ticketContext(fs: Fs, tags: ReadonlySet<string>, role: "builder" | "qa",
  settings: Settings): Promise<TicketContext & { packNames: string[] }> {
  const content = await loadContent(fs);
  const packs = packsFor(content, tags);
  const texts = await packTexts(fs, content, packs, { stack: settings.stack?.value as Record<string, string>,
    flags: settings.flags?.value as Record<string, boolean>, docsRoot: settings["docs.root"]?.value as string });
  return { packs: texts, packNames: packs.map((p) => p.name), skills: skillsFor(content, role, tags),
    tools: toolsFor(settings.tools?.value, role, tags).map((t) => t.line) };
}
