import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { StructuredPlanDeliveryUnit, StructuredPlanSlice, StructuredPlanStack, StructuredPlanV1 } from "rafi-spec";
import { capturePreimage, finalizeOwnedWrite } from "./ownership.js";

export const PLAN_PROPOSAL_START = "RAFI_PLAN_PROPOSAL_START";
export const PLAN_PROPOSAL_END = "RAFI_PLAN_PROPOSAL_END";
export const MAX_PLAN_STACK_DEPTH = 5;

export interface PlanSliceProposal {
  local_ref: string;
  retains?: string;
  title: string;
  summary: string;
  acceptance: string[];
  required_tests: string[];
  likely_files: string[];
  depends_on: string[];
  source_refs?: Array<{ source_id: string; fingerprint: string; item?: string; url?: string | null; note?: string | null }>;
}

export interface PlanDeliveryUnitProposal extends Omit<StructuredPlanDeliveryUnit, "slice_refs"> {
  slice_refs: string[];
}

export interface PlanStackProposal {
  local_ref: string;
  retains?: string;
  name: string;
  units: string[];
}

export interface StructuredPlanProposalV1 {
  version: 1;
  summary: string;
  assumptions: string[];
  implementation_changes: string[];
  acceptance_criteria: string[];
  test_plan: string[];
  slices: PlanSliceProposal[];
  delivery_units: PlanDeliveryUnitProposal[];
  stacks: PlanStackProposal[];
}

export interface StructuredPlanArtifactPaths {
  historyMarkdown: string;
  historyData: string;
  latestMarkdown: string;
  latestData: string;
}

export function extractStructuredPlanProposal(output: string): StructuredPlanProposalV1 {
  const start = output.lastIndexOf(PLAN_PROPOSAL_START);
  const end = output.lastIndexOf(PLAN_PROPOSAL_END);
  if (start < 0 || end <= start) throw new Error(`planner output is missing ${PLAN_PROPOSAL_START}/${PLAN_PROPOSAL_END}`);
  const json = output.slice(start + PLAN_PROPOSAL_START.length, end).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch (error) { throw new Error(`structured plan proposal is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const issues = validateStructuredPlanProposal(parsed);
  if (issues.length) throw new Error(`invalid structured plan proposal:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  return parsed as StructuredPlanProposalV1;
}

export function validateStructuredPlanProposal(value: unknown): string[] {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["proposal must be an object"];
  const p = value as Record<string, unknown>;
  if (p.version !== 1) issues.push("version must be 1");
  for (const field of ["summary"] as const) if (typeof p[field] !== "string" || !p[field].trim()) issues.push(`${field} must be non-empty`);
  for (const field of ["assumptions", "implementation_changes", "acceptance_criteria", "test_plan", "slices", "delivery_units", "stacks"] as const) if (!Array.isArray(p[field])) issues.push(`${field} must be an array`);
  for (const field of ["assumptions", "implementation_changes", "acceptance_criteria", "test_plan"] as const) {
    if (Array.isArray(p[field]) && !p[field].every((item) => typeof item === "string")) issues.push(`${field} must be a string array`);
  }
  if (issues.length) return issues;
  const proposal = p as Record<string, unknown> & StructuredPlanProposalV1;
  const localRefs = new Set<string>();
  for (const [index, rawSlice] of proposal.slices.entries()) {
    if (!rawSlice || typeof rawSlice !== "object" || Array.isArray(rawSlice)) { issues.push(`slices[${index}] must be an object`); continue; }
    const slice = rawSlice as Record<string, unknown> & PlanSliceProposal;
    if (typeof slice.local_ref !== "string" || !slice.local_ref) { issues.push(`slices[${index}].local_ref is required`); continue; }
    if (localRefs.has(slice.local_ref)) issues.push(`duplicate slice local_ref ${slice.local_ref}`);
    localRefs.add(slice.local_ref);
    for (const field of ["title", "summary"] as const) if (typeof slice[field] !== "string" || !slice[field].trim()) issues.push(`slice ${slice.local_ref}.${field} is required`);
    for (const field of ["acceptance", "required_tests", "likely_files", "depends_on"] as const) if (!Array.isArray(slice[field]) || !slice[field].every((item) => typeof item === "string")) issues.push(`slice ${slice.local_ref}.${field} must be a string array`);
    if (slice.source_refs !== undefined && !Array.isArray(slice.source_refs)) {
      issues.push(`slice ${slice.local_ref}.source_refs must be an array`);
    } else if (Array.isArray(slice.source_refs)) {
      for (const [refIndex, rawRef] of slice.source_refs.entries()) {
        const ref = rawRef as Record<string, unknown> | undefined;
        if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
          issues.push(`slice ${slice.local_ref}.source_refs[${refIndex}] must be an object`);
          continue;
        }
        if (typeof ref.source_id !== "string" || !/^src_[A-Za-z0-9_-]+$/.test(ref.source_id) || typeof ref.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(ref.fingerprint)) issues.push(`slice ${slice.local_ref}.source_refs[${refIndex}] is invalid`);
        for (const field of ["item", "url", "note"] as const) {
          if (ref[field] !== undefined && ref[field] !== null && typeof ref[field] !== "string") issues.push(`slice ${slice.local_ref}.source_refs[${refIndex}].${field} must be a string or null`);
        }
      }
    }
  }
  for (const rawSlice of proposal.slices) {
    if (!rawSlice || typeof rawSlice !== "object" || Array.isArray(rawSlice)) continue;
    const slice = rawSlice as Record<string, unknown> & PlanSliceProposal;
    if (typeof slice.local_ref !== "string" || !Array.isArray(slice.depends_on)) continue;
    for (const dep of slice.depends_on) {
      if (typeof dep !== "string") continue;
      if (dep === slice.local_ref) issues.push(`slice ${slice.local_ref} cannot depend on itself`);
      else if (!localRefs.has(dep)) issues.push(`slice ${slice.local_ref} depends on unknown local_ref ${dep}`);
    }
  }
  const unitIds = new Set<string>();
  const assigned = new Set<string>();
  for (const [index, rawUnit] of proposal.delivery_units.entries()) {
    if (!rawUnit || typeof rawUnit !== "object" || Array.isArray(rawUnit)) { issues.push(`delivery_units[${index}] must be an object`); continue; }
    const unit = rawUnit as Record<string, unknown> & PlanDeliveryUnitProposal;
    if (typeof unit.id !== "string" || !unit.id) issues.push(`delivery_units[${index}].id is required`);
    else if (unitIds.has(unit.id)) issues.push(`duplicate delivery unit ID ${unit.id}`);
    else unitIds.add(unit.id);
    if (!stringArray(unit.slice_refs)) issues.push(`delivery unit ${unit.id || index}.slice_refs must be a string array`);
    enumValue(issues, `delivery unit ${unit.id || index}.branch_mode`, unit.branch_mode, ["current", "per-ticket", "shared"]);
    enumValue(issues, `delivery unit ${unit.id || index}.completion`, unit.completion, ["pr", "auto-merge", "direct-merge", "none"]);
    enumValue(issues, `delivery unit ${unit.id || index}.provider`, unit.provider, ["auto", "github", "gitlab", "local"]);
    if (typeof unit.pr_ready !== "boolean") issues.push(`delivery unit ${unit.id || index}.pr_ready must be a boolean`);
    enumValue(issues, `delivery unit ${unit.id || index}.merge_method`, unit.merge_method, ["squash", "merge", "rebase"]);
    if (typeof unit.cleanup !== "boolean") issues.push(`delivery unit ${unit.id || index}.cleanup must be a boolean`);
    if (!stringArray(unit.depends_on)) issues.push(`delivery unit ${unit.id || index}.depends_on must be a string array`);
    enumValue(issues, `delivery unit ${unit.id || index}.dependency_mode`, unit.dependency_mode, ["combine", "wait", "stack"]);
    for (const ref of stringArray(unit.slice_refs) ? unit.slice_refs : []) {
      if (!localRefs.has(ref)) issues.push(`delivery unit ${unit.id} references unknown slice ${ref}`);
      if (assigned.has(ref)) issues.push(`slice ${ref} is assigned to multiple delivery units`); else assigned.add(ref);
    }
  }
  for (const rawUnit of proposal.delivery_units) {
    if (!rawUnit || typeof rawUnit !== "object" || Array.isArray(rawUnit)) continue;
    const unit = rawUnit as Record<string, unknown> & PlanDeliveryUnitProposal;
    if (typeof unit.id !== "string" || !Array.isArray(unit.depends_on)) continue;
    for (const dep of unit.depends_on) {
      if (typeof dep !== "string") continue;
      if (dep === unit.id) issues.push(`delivery unit ${unit.id} cannot depend on itself`);
      else if (!unitIds.has(dep)) issues.push(`delivery unit ${unit.id} depends on unknown unit ${dep}`);
    }
  }
  for (const ref of localRefs) if (!assigned.has(ref)) issues.push(`slice ${ref} is not assigned to a delivery unit`);
  const stackLocals = new Set<string>();
  const stackedUnits = new Set<string>();
  for (const [index, rawStack] of proposal.stacks.entries()) {
    if (!rawStack || typeof rawStack !== "object" || Array.isArray(rawStack)) { issues.push(`stacks[${index}] must be an object`); continue; }
    const stack = rawStack as Record<string, unknown> & PlanStackProposal;
    if (typeof stack.local_ref !== "string" || !stack.local_ref) issues.push(`stacks[${index}].local_ref is required`);
    else if (stackLocals.has(stack.local_ref)) issues.push(`duplicate stack local_ref ${stack.local_ref}`);
    else stackLocals.add(stack.local_ref);
    if (typeof stack.name !== "string" || !stack.name.trim()) issues.push(`stack ${stack.local_ref || index}.name is required`);
    if (!stringArray(stack.units) || stack.units.length === 0) issues.push(`stack ${stack.local_ref || index}.units must be a non-empty string array`);
    if (stringArray(stack.units) && stack.units.length > MAX_PLAN_STACK_DEPTH) issues.push(`stack ${stack.local_ref} has depth ${stack.units.length}; maximum is ${MAX_PLAN_STACK_DEPTH}`);
    for (const id of stringArray(stack.units) ? stack.units : []) {
      if (!unitIds.has(id)) issues.push(`stack ${stack.local_ref} references unknown unit ${id}`);
      if (stackedUnits.has(id)) issues.push(`delivery unit ${id} belongs to multiple stacks`); else stackedUnits.add(id);
    }
  }
  return [...new Set(issues)];
}

export function materializeStructuredPlan(
  proposal: StructuredPlanProposalV1,
  previous?: StructuredPlanV1,
  allocate: () => string = randomUUID,
): StructuredPlanV1 {
  const issues = validateStructuredPlanProposal(proposal);
  if (issues.length) throw new Error(issues.join("; "));
  const previousSlices = new Map(previous?.slices.map((slice) => [slice.slice_ref, slice]) ?? []);
  const previousStacks = new Map(previous?.stacks.map((stack) => [stack.stack_id, stack]) ?? []);
  const refMap = new Map<string, string>();
  for (const slice of proposal.slices) {
    if (slice.retains && !previousSlices.has(slice.retains)) throw new Error(`slice ${slice.local_ref} retains unknown reference ${slice.retains}`);
    refMap.set(slice.local_ref, slice.retains ?? `slc_${allocate()}`);
  }
  const slices: StructuredPlanSlice[] = proposal.slices.map((slice) => ({
    slice_ref: refMap.get(slice.local_ref)!, title: slice.title, summary: slice.summary,
    acceptance: [...slice.acceptance], required_tests: [...slice.required_tests], likely_files: [...slice.likely_files],
    depends_on: slice.depends_on.map((ref) => refMap.get(ref)!),
    source_refs: slice.source_refs?.map((ref) => ({ ...ref })),
  }));
  const delivery_units = proposal.delivery_units.map((unit) => ({ ...unit, slice_refs: unit.slice_refs.map((ref) => refMap.get(ref)!) }));
  const stacks: StructuredPlanStack[] = proposal.stacks.map((stack) => {
    if (stack.retains && !previousStacks.has(stack.retains)) throw new Error(`stack ${stack.local_ref} retains unknown reference ${stack.retains}`);
    return { stack_id: stack.retains ?? `stk_${allocate()}`, name: stack.name, units: [...stack.units] };
  });
  const plan: StructuredPlanV1 = {
    version: 1, plan_id: previous?.plan_id ?? `pln_${allocate()}`, revision: (previous?.revision ?? 0) + 1,
    content_digest: "", summary: proposal.summary, assumptions: [...proposal.assumptions],
    implementation_changes: [...proposal.implementation_changes], acceptance_criteria: [...proposal.acceptance_criteria],
    test_plan: [...proposal.test_plan], slices, delivery_units, stacks,
  };
  plan.content_digest = structuredPlanDigest(plan);
  const planIssues = validateMaterializedPlan(plan);
  if (planIssues.length) throw new Error(`invalid materialized plan:\n${planIssues.map((issue) => `- ${issue}`).join("\n")}`);
  return plan;
}

export function structuredPlanDigest(plan: StructuredPlanV1): string {
  return createHash("sha256").update(canonicalJson({ ...plan, content_digest: "" })).digest("hex");
}

export function validateMaterializedPlan(plan: StructuredPlanV1): string[] {
  const issues: string[] = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return ["plan must be an object"];
  const raw = plan as unknown as Record<string, unknown>;
  if (raw.version !== 1) issues.push("version must be 1");
  if (typeof raw.plan_id !== "string" || !raw.plan_id || !Number.isInteger(raw.revision) || Number(raw.revision) < 1 || typeof raw.content_digest !== "string") issues.push("plan identity is invalid");
  for (const field of ["summary"] as const) if (typeof raw[field] !== "string" || !raw[field].trim()) issues.push(`${field} must be non-empty`);
  for (const field of ["assumptions", "implementation_changes", "acceptance_criteria", "test_plan", "slices", "delivery_units", "stacks"] as const) if (!Array.isArray(raw[field])) issues.push(`${field} must be an array`);
  for (const field of ["assumptions", "implementation_changes", "acceptance_criteria", "test_plan"] as const) {
    if (Array.isArray(raw[field]) && !raw[field].every((item) => typeof item === "string")) issues.push(`${field} must be a string array`);
  }
  if (issues.length) return issues;
  if (plan.content_digest !== structuredPlanDigest(plan)) issues.push("content digest does not match structured data");
  const refs = new Set<string>();
  for (const [index, rawSlice] of plan.slices.entries()) {
    if (!rawSlice || typeof rawSlice !== "object" || Array.isArray(rawSlice)) { issues.push(`slices[${index}] must be an object`); continue; }
    const slice = rawSlice as Record<string, unknown> & StructuredPlanSlice;
    if (typeof slice.slice_ref !== "string" || !slice.slice_ref) issues.push(`slices[${index}].slice_ref is required`);
    else refs.add(slice.slice_ref);
    for (const field of ["title", "summary"] as const) if (typeof slice[field] !== "string" || !slice[field].trim()) issues.push(`slice ${slice.slice_ref || index}.${field} is required`);
    for (const field of ["acceptance", "required_tests", "likely_files", "depends_on"] as const) if (!stringArray(slice[field])) issues.push(`slice ${slice.slice_ref || index}.${field} must be a string array`);
    if (slice.source_refs !== undefined && !Array.isArray(slice.source_refs)) issues.push(`slice ${slice.slice_ref || index}.source_refs must be an array`);
    if (Array.isArray(slice.source_refs)) for (const [refIndex, rawRef] of slice.source_refs.entries()) {
      const ref = rawRef as unknown as Record<string, unknown> | undefined;
      if (!ref || typeof ref !== "object" || Array.isArray(ref) || typeof ref.source_id !== "string" || !/^src_[A-Za-z0-9_-]+$/.test(ref.source_id) || typeof ref.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(ref.fingerprint)) issues.push(`slice ${slice.slice_ref || index}.source_refs[${refIndex}] is invalid`);
    }
  }
  if (refs.size !== plan.slices.length) issues.push("slice references are duplicated");
  for (const rawSlice of plan.slices) {
    if (!rawSlice || typeof rawSlice !== "object" || Array.isArray(rawSlice)) continue;
    const slice = rawSlice as Record<string, unknown> & StructuredPlanSlice;
    if (typeof slice.slice_ref !== "string" || !Array.isArray(slice.depends_on)) continue;
    for (const dep of slice.depends_on) {
      if (typeof dep !== "string") continue;
      if (dep === slice.slice_ref) issues.push(`slice ${slice.slice_ref} cannot depend on itself`);
      else if (!refs.has(dep)) issues.push(`slice ${slice.slice_ref} depends on unknown slice ${dep}`);
    }
  }
  const unitById = new Map<string, StructuredPlanDeliveryUnit>();
  for (const [index, rawUnit] of plan.delivery_units.entries()) {
    if (!rawUnit || typeof rawUnit !== "object" || Array.isArray(rawUnit)) { issues.push(`delivery_units[${index}] must be an object`); continue; }
    const unit = rawUnit as Record<string, unknown> & StructuredPlanDeliveryUnit;
    if (typeof unit.id !== "string" || !unit.id) issues.push(`delivery_units[${index}].id is required`);
    else if (unitById.has(unit.id)) issues.push(`duplicate delivery unit ID ${unit.id}`);
    else unitById.set(unit.id, unit);
    if (!stringArray(unit.slice_refs)) issues.push(`unit ${unit.id || index}.slice_refs must be a string array`);
    enumValue(issues, `unit ${unit.id || index}.branch_mode`, unit.branch_mode, ["current", "per-ticket", "shared"]);
    enumValue(issues, `unit ${unit.id || index}.completion`, unit.completion, ["pr", "auto-merge", "direct-merge", "none"]);
    enumValue(issues, `unit ${unit.id || index}.provider`, unit.provider, ["auto", "github", "gitlab", "local"]);
    if (typeof unit.pr_ready !== "boolean") issues.push(`unit ${unit.id || index}.pr_ready must be a boolean`);
    enumValue(issues, `unit ${unit.id || index}.merge_method`, unit.merge_method, ["squash", "merge", "rebase"]);
    if (typeof unit.cleanup !== "boolean") issues.push(`unit ${unit.id || index}.cleanup must be a boolean`);
    if (!stringArray(unit.depends_on)) issues.push(`unit ${unit.id || index}.depends_on must be a string array`);
    enumValue(issues, `unit ${unit.id || index}.dependency_mode`, unit.dependency_mode, ["combine", "wait", "stack"]);
    for (const ref of stringArray(unit.slice_refs) ? unit.slice_refs : []) if (!refs.has(ref)) issues.push(`unit ${unit.id} references unknown slice ${ref}`);
  }
  if (unitById.size !== plan.delivery_units.length) issues.push("delivery unit IDs are duplicated");
  const assigned = new Set<string>();
  for (const unit of unitById.values()) for (const ref of stringArray(unit.slice_refs) ? unit.slice_refs : []) {
    if (assigned.has(ref)) issues.push(`slice ${ref} is assigned to multiple delivery units`); else assigned.add(ref);
  }
  for (const unit of unitById.values()) for (const dep of stringArray(unit.depends_on) ? unit.depends_on : []) {
    if (dep === unit.id) issues.push(`unit ${unit.id} cannot depend on itself`);
    else if (!unitById.has(dep)) issues.push(`unit ${unit.id} depends on unknown unit ${dep}`);
  }
  for (const ref of refs) if (!assigned.has(ref)) issues.push(`slice ${ref} is not assigned to a delivery unit`);
  const stackedUnits = new Set<string>();
  for (const [index, rawStack] of plan.stacks.entries()) {
    if (!rawStack || typeof rawStack !== "object" || Array.isArray(rawStack)) { issues.push(`stacks[${index}] must be an object`); continue; }
    const stack = rawStack as Record<string, unknown> & StructuredPlanStack;
    if (typeof stack.stack_id !== "string" || !stack.stack_id) issues.push(`stacks[${index}].stack_id is required`);
    if (typeof stack.name !== "string" || !stack.name.trim()) issues.push(`stack ${stack.stack_id || index}.name is required`);
    if (!stringArray(stack.units) || stack.units.length === 0) { issues.push(`stack ${stack.stack_id || index}.units must be a non-empty string array`); continue; }
    const nodes: string[] = [];
    const providers = new Set<string>();
    for (const unitId of stack.units) {
      const unit = unitById.get(unitId);
      if (!unit) { issues.push(`stack ${stack.stack_id} references unknown unit ${unitId}`); continue; }
      if (stackedUnits.has(unitId)) issues.push(`unit ${unitId} belongs to multiple stacks`); else stackedUnits.add(unitId);
      if (unit.branch_mode === "current") issues.push(`current-branch unit ${unitId} cannot be stacked`);
      if (unit.completion !== "pr" || !["github", "gitlab"].includes(unit.provider)) issues.push(`stacked unit ${unitId} must open GitHub or GitLab PRs`);
      providers.add(unit.provider);
      if (unit.dependency_mode !== "stack") issues.push(`stacked unit ${unitId} must use dependency_mode stack`);
      if (unit.branch_mode === "shared") nodes.push(unitId); else nodes.push(...(stringArray(unit.slice_refs) ? unit.slice_refs : []).map((ref) => `${unitId}:${ref}`));
    }
    if (providers.size > 1) issues.push(`stack ${stack.stack_id} cannot mix PR providers`);
    if (nodes.length > MAX_PLAN_STACK_DEPTH) issues.push(`stack ${stack.stack_id} normalized PR depth ${nodes.length} exceeds ${MAX_PLAN_STACK_DEPTH}`);
    const root = unitById.get(stack.units[0]!);
    if (root && stringArray(root.depends_on) && root.depends_on.length) issues.push(`stack ${stack.stack_id} root unit ${root.id} cannot have a stack parent`);
    for (let index = 1; index < stack.units.length; index++) {
      const current = unitById.get(stack.units[index]!); const prior = stack.units[index - 1]!;
      if (current && stringArray(current.depends_on) && (current.depends_on.length !== 1 || current.depends_on[0] !== prior)) issues.push(`stack ${stack.stack_id} unit ${current.id} must depend only on ${prior}`);
    }
  }
  return issues;
}

export function renderStructuredPlanMarkdown(plan: StructuredPlanV1): string {
  const issues = validateMaterializedPlan(plan);
  if (issues.length) throw new Error(`plan data is invalid: ${issues.join("; ")}`);
  const bullets = (values: string[]) => values.length ? values.map((value) => `- ${value}`).join("\n") : "- None.";
  const lines = [
    `<!-- rafi-plan plan_id=${plan.plan_id} revision=${plan.revision} digest=${plan.content_digest} -->`,
    `# Rafi Plan: ${plan.summary}`, "", "## Summary", "", plan.summary, "", "## Assumptions", "", bullets(plan.assumptions),
    "", "## Implementation Changes", "", bullets(plan.implementation_changes), "", "## Acceptance Criteria", "", bullets(plan.acceptance_criteria),
    "", "## Test Plan", "", bullets(plan.test_plan), "", "## Ticket Slices", "",
  ];
  for (const slice of plan.slices) lines.push(`### ${slice.title} (${slice.slice_ref})`, "", slice.summary, "", `Dependencies: ${slice.depends_on.join(", ") || "None"}`, "", "Acceptance:", bullets(slice.acceptance), "", "Required tests:", bullets(slice.required_tests), "", `Likely files: ${slice.likely_files.join(", ") || "unknown"}`, "");
  lines.push("## Delivery Units", "");
  for (const unit of plan.delivery_units) lines.push(`- ${unit.id}: slices ${unit.slice_refs.join(", ")}; branch_mode=${unit.branch_mode}; completion=${unit.completion}; provider=${unit.provider}; depends_on=${unit.depends_on.join(",") || "none"}; dependency_mode=${unit.dependency_mode}`);
  lines.push("", "## Delivery Stacks", "");
  if (!plan.stacks.length) lines.push("- None.");
  for (const stack of plan.stacks) lines.push(`- ${stack.name} (${stack.stack_id}): ${stack.units.join(" -> ")}`);
  return `${lines.join("\n").trimEnd()}\n`;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function enumValue(issues: string[], path: string, value: unknown, allowed: string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) issues.push(`${path} must be one of: ${allowed.join(", ")}`);
}

export function resolveStructuredPlanArtifactPaths(projectDir: string, docsRoot: string, plan: StructuredPlanV1): StructuredPlanArtifactPaths {
  const stem = `${plan.plan_id}-r${plan.revision}`;
  return {
    historyMarkdown: resolve(projectDir, docsRoot, "rafi-plans", `${stem}.md`), historyData: resolve(projectDir, docsRoot, "rafi-plans", `${stem}.json`),
    latestMarkdown: resolve(projectDir, docsRoot, "rafi-plan.md"), latestData: resolve(projectDir, docsRoot, "rafi-plan.json"),
  };
}

export function writeStructuredPlanArtifacts(projectDir: string, docsRoot: string, plan: StructuredPlanV1): StructuredPlanArtifactPaths {
  const issues = validateMaterializedPlan(plan); if (issues.length) throw new Error(issues.join("; "));
  const paths = resolveStructuredPlanArtifactPaths(projectDir, docsRoot, plan);
  if (existsSync(paths.historyMarkdown) || existsSync(paths.historyData)) throw new Error(`approved plan revision ${plan.plan_id} r${plan.revision} already exists and is immutable`);
  const markdown = renderStructuredPlanMarkdown(plan); const data = `${canonicalJson(plan, 2)}\n`;
  const ownership = Object.values(paths).map((path) => capturePreimage(projectDir, relative(resolve(projectDir), path).replace(/\\/g, "/"), "structured-plan", "plans"));
  mkdirSync(dirname(paths.historyMarkdown), { recursive: true });
  atomicWrite(paths.historyMarkdown, markdown, false); atomicWrite(paths.historyData, data, false);
  atomicWrite(paths.latestMarkdown, markdown, true); atomicWrite(paths.latestData, data, true);
  ownership.forEach((entry) => finalizeOwnedWrite(projectDir, entry));
  return paths;
}

export function readAndValidateStructuredPlanPair(markdownPath: string, dataPath: string): StructuredPlanV1 {
  if (!existsSync(markdownPath) || !existsSync(dataPath)) throw new Error("plan pair is incomplete; both Markdown and structured data are required");
  const plan = JSON.parse(readFileSync(dataPath, "utf8")) as StructuredPlanV1;
  const issues = validateMaterializedPlan(plan); if (issues.length) throw new Error(`plan data is invalid: ${issues.join("; ")}`);
  const markdown = readFileSync(markdownPath, "utf8");
  if (markdown !== renderStructuredPlanMarkdown(plan)) throw new Error(`plan pair mismatch for ${plan.plan_id} r${plan.revision}; regenerate Markdown from structured data`);
  return plan;
}

export function readNamedApprovedPlan(projectDir: string, docsRoot: string, planId: string): StructuredPlanV1 {
  const directory = resolve(projectDir, docsRoot, "rafi-plans");
  if (!existsSync(directory)) throw new Error(`approved plan not found: ${planId}`);
  const escaped = planId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = readdirSync(directory).map((name) => new RegExp(`^${escaped}-r(\\d+)\\.json$`).exec(name)).filter((match): match is RegExpExecArray => Boolean(match));
  if (!matches.length) throw new Error(`approved plan not found: ${planId}`);
  const revision = Math.max(...matches.map((match) => Number(match[1])));
  return readAndValidateStructuredPlanPair(join(directory, `${planId}-r${revision}.md`), join(directory, `${planId}-r${revision}.json`));
}

export function regenerateStructuredPlanMarkdown(markdownPath: string, dataPath: string): StructuredPlanV1 {
  const plan = JSON.parse(readFileSync(dataPath, "utf8")) as StructuredPlanV1;
  const issues = validateMaterializedPlan(plan); if (issues.length) throw new Error(issues.join("; "));
  atomicWrite(markdownPath, renderStructuredPlanMarkdown(plan), true); return plan;
}

function canonicalJson(value: unknown, space?: number): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)])) : item;
  return JSON.stringify(normalize(value), null, space);
}

function atomicWrite(path: string, content: string, replace: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!replace) { const fd = openSync(path, "wx", 0o644); try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); } return; }
  const temp = join(dirname(path), `.${randomUUID()}.tmp`); const fd = openSync(temp, "wx", 0o644);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
