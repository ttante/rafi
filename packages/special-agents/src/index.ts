/**
 * special-agents — the Rafi library. Re-exports the neutral schema, the templating
 * engine, and the content loaders. The higher-level composition API (getAgent,
 * getSkill, compile) is layered on these in the rest of Phase 3.
 */
export * from "rafi-spec";
export { render, type TemplateContext } from "./template.js";
export {
  CONTENT_DIR,
  DOCS_DIR,
  parseRulePack,
  loadDefaults,
  loadDocsIndex,
  loadPreamble,
  loadPacksIndex,
  loadPack,
  loadAllPacks,
  packFilesOnDisk,
  type Defaults,
  type PackIndexEntry,
  type LoadedPack,
  type DocIndexEntry,
} from "./content.js";
export {
  composeRulesMarkdown,
  composeAgentSystem,
  getAgent,
  buildConditionsHeader,
  CUSTOM_ARTIFACTS_NOTE,
  renderAgentsMd,
  renderClaudeMd,
  emitAgentsMd,
  emitClaudeMd,
  emitCompiledBundles,
  emitClaudeAgents,
  emitMappedClaudeAgents,
  emitCodexAgents,
  emitSkills,
  renderPackBody,
  type CompileOptions,
  type AgentComposeOptions,
  type ComposedAgent,
  type EmitOptions,
  type EmitMappedOptions,
  type EmitSkillsOptions,
} from "./compile.js";
export {
  resolvePackRefs,
  resolveAgentPacks,
  type ConditionFlags,
  type ResolveContext,
  type ResolvableManifest,
} from "./resolve.js";
export {
  SKILLS_DIR,
  parseSkillManifest,
  loadSkill,
  loadAllSkills,
  skillNames,
} from "./skills.js";
export {
  AGENTS_DIR,
  AGENT_ROLES,
  parseAgentManifest,
  loadAgent,
  loadAllAgents,
} from "./agents.js";
