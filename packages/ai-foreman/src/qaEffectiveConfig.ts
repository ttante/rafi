import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { loadSkill } from "special-agents";
import type { ResolvedAgentSettings } from "rafi-spec";
import { loadRoleBundle } from "./roles.js";
import { loadTicketSetupConfigWithDefaults, loadRafiConfigObject } from "./tickets/setupConfig.js";
import { resolveQaPreparationConfig } from "./qaPreparationPolicy.js";
import { contractDigest } from "./qaVerificationContract.js";
export const FINAL_QA_ROLE_SUFFIX = "You are an independent QA reviewer. Do not edit source, tickets, configuration, or project documentation. You may run tests and create only harmless ignored caches or coverage output.";
export function finalQaRoleInstructions(rules: string): string { return `${rules}\n\n${FINAL_QA_ROLE_SUFFIX}`; }

export function loadQaPreparationPolicy(projectDir: string) {
  return resolveQaPreparationConfig(loadRafiConfigObject(projectDir)?.qa_preparation);
}
/** Resolve only explicit rule/skill content; never project secrets or mutable .rafi state. */
export function resolveEffectiveQaConfiguration(projectDir: string, settings: Pick<ResolvedAgentSettings, "make">) {
  const root = realpathSync(projectDir);
  for (const role of ["qa", "builder"]) for (const file of ["system.md", "meta.json"]) {
    const path = join(root, ".rafi", "compiled", role, file);
    if (existsSync(path) && !realpathSync(path).startsWith(root + sep)) throw new Error("Compiled role configuration escapes the canonical root");
  }
  const bundle = loadRoleBundle("qa", { projectDir: root });
  const builder = loadRoleBundle("builder", { projectDir: root });
  const checklist = [...loadTicketSetupConfigWithDefaults(root).build.validation_checklist];
  const skills = bundle.skills.map(name => {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Unsafe QA skill reference ${name}`);
    const runtimeRoot = settings.make === "codex" ? ".codex" : ".claude";
    const path = [join(root, runtimeRoot, "skills", name, "SKILL.md"), join(root, ".agents", "skills", name, "SKILL.md")].find(existsSync);
    if (path && !realpathSync(path).startsWith(root + sep)) throw new Error(`QA skill ${name} escapes the canonical configuration root`);
    const skill = path ? { name, body: readFileSync(path, "utf8") } : loadSkill(name);
    if (!skill.body?.trim()) throw new Error(`QA skill ${name} has no dispatchable content`);
    const content = `## ${skill.name}\n${skill.body.trim()}`;
    return { name, path: path ?? `special-agents:${name}`, content, digest: contractDigest("skill-content", content) };
  });
  const common = { configRoot: resolve(root), qaRules: bundle.system, builderRules: builder.system, checklist, skills, roleSource: bundle.source, builderRoleSource: builder.source };
  return { ...common, digest: contractDigest("effective-qa-config", common) };
}
