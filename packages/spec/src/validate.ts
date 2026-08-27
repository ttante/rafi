/** ajv-backed validation for the neutral schemas. */
import { Ajv, type ValidateFunction } from "ajv";
import {
  rulePackSchema,
  skillManifestSchema,
  agentManifestSchema,
  projectConfigSchema,
  agentDefaultsSchema,
  buildRunRecordSchema,
  installManifestSchema,
} from "./schemas.js";
import type {
  RulePackFrontmatter,
  SkillManifest,
  AgentManifest,
  ProjectConfig,
  AgentDefaultsV1,
} from "./types.js";

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

/** Outcome of validating a value against one of the neutral schemas. */
export interface ValidationResult {
  valid: boolean;
  /** Human-readable messages; empty when valid. */
  errors: string[];
}

function run(fn: ValidateFunction, data: unknown): ValidationResult {
  const valid = fn(data) as boolean;
  if (valid) return { valid: true, errors: [] };
  const errors = (fn.errors ?? []).map(
    (e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim(),
  );
  return { valid: false, errors };
}

const vRulePack = ajv.compile(rulePackSchema);
const vSkill = ajv.compile(skillManifestSchema);
const vAgent = ajv.compile(agentManifestSchema);
const vProject = ajv.compile(projectConfigSchema);
const vAgentDefaults = ajv.compile(agentDefaultsSchema);
const vBuildRun = ajv.compile(buildRunRecordSchema);
const vInstallManifest = ajv.compile(installManifestSchema);

export const validateRulePack = (d: unknown): ValidationResult => run(vRulePack, d);
export const validateSkillManifest = (d: unknown): ValidationResult => run(vSkill, d);
export const validateAgentManifest = (d: unknown): ValidationResult => run(vAgent, d);
export const validateProjectConfig = (d: unknown): ValidationResult => run(vProject, d);
export const validateAgentDefaults = (d: unknown): ValidationResult => run(vAgentDefaults, d);
export const validateBuildRunRecord = (d: unknown): ValidationResult => run(vBuildRun, d);
export const validateInstallManifest = (d: unknown): ValidationResult => run(vInstallManifest, d);

/** Validate and narrow, throwing on failure. */
export function assertRulePack(d: unknown): asserts d is RulePackFrontmatter {
  const r = validateRulePack(d);
  if (!r.valid) throw new Error(`Invalid rule pack: ${r.errors.join("; ")}`);
}
export function assertSkillManifest(d: unknown): asserts d is SkillManifest {
  const r = validateSkillManifest(d);
  if (!r.valid) throw new Error(`Invalid skill manifest: ${r.errors.join("; ")}`);
}
export function assertAgentManifest(d: unknown): asserts d is AgentManifest {
  const r = validateAgentManifest(d);
  if (!r.valid) throw new Error(`Invalid agent manifest: ${r.errors.join("; ")}`);
}
export function assertProjectConfig(d: unknown): asserts d is ProjectConfig {
  const r = validateProjectConfig(d);
  if (!r.valid) throw new Error(`Invalid project config: ${r.errors.join("; ")}`);
}
export function assertAgentDefaults(d: unknown): asserts d is AgentDefaultsV1 {
  const r = validateAgentDefaults(d);
  if (!r.valid) throw new Error(`Invalid agent defaults: ${r.errors.join("; ")}`);
}
