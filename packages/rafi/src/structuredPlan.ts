import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { StructuredPlanDeliveryUnit, StructuredPlanSlice, StructuredPlanStack, StructuredPlanV1 } from "rafi-spec";

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
  if (issues.length) return issues;
  const proposal = p as unknown as StructuredPlanProposalV1;
  const localRefs = new Set<string>();
  for (const [index, slice] of proposal.slices.entries()) {
    if (!slice || typeof slice.local_ref !== "string" || !slice.local_ref) { issues.push(`slices[${index}].local_ref is required`); continue; }
    if (localRefs.has(slice.local_ref)) issues.push(`duplicate slice local_ref ${slice.local_ref}`);
    localRefs.add(slice.local_ref);
    for (const field of ["title", "summary"] as const) if (typeof slice[field] !== "string" || !slice[field].trim()) issues.push(`slice ${slice.local_ref}.${field} is required`);
    for (const field of ["acceptance", "required_tests", "likely_files", "depends_on"] as const) if (!Array.isArray(slice[field]) || !slice[field].every((item) => typeof item === "string")) issues.push(`slice ${slice.local_ref}.${field} must be a string array`);
  }
  for (const slice of proposal.slices) for (const dep of slice.depends_on ?? []) if (!localRefs.has(dep)) issues.push(`slice ${slice.local_ref} depends on unknown local_ref ${dep}`);
  const unitIds = new Set<string>();
  const assigned = new Set<string>();
  for (const unit of proposal.delivery_units) {
    if (!unit?.id || unitIds.has(unit.id)) issues.push(`duplicate or missing delivery unit ID ${unit?.id ?? ""}`); else unitIds.add(unit.id);
    for (const ref of unit?.slice_refs ?? []) {
      if (!localRefs.has(ref)) issues.push(`delivery unit ${unit.id} references unknown slice ${ref}`);
      if (assigned.has(ref)) issues.push(`slice ${ref} is assigned to multiple delivery units`); else assigned.add(ref);
    }
  }
  for (const ref of localRefs) if (!assigned.has(ref)) issues.push(`slice ${ref} is not assigned to a delivery unit`);
  const stackLocals = new Set<string>();
  const stackedUnits = new Set<string>();
  for (const stack of proposal.stacks) {
    if (!stack?.local_ref || stackLocals.has(stack.local_ref)) issues.push(`duplicate or missing stack local_ref ${stack?.local_ref ?? ""}`); else stackLocals.add(stack.local_ref);
    if (!stack.name?.trim()) issues.push(`stack ${stack.local_ref} needs a name`);
    if (!Array.isArray(stack.units) || stack.units.length === 0) issues.push(`stack ${stack.local_ref} must contain units`);
    if ((stack.units?.length ?? 0) > MAX_PLAN_STACK_DEPTH) issues.push(`stack ${stack.local_ref} has depth ${stack.units.length}; maximum is ${MAX_PLAN_STACK_DEPTH}`);
    for (const id of stack.units ?? []) {
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
  if (!plan.plan_id || !Number.isInteger(plan.revision) || plan.revision < 1) issues.push("plan identity is invalid");
  if (plan.content_digest !== structuredPlanDigest(plan)) issues.push("content digest does not match structured data");
  const refs = new Set(plan.slices.map((slice) => slice.slice_ref));
  if (refs.size !== plan.slices.length) issues.push("slice references are duplicated");
  for (const unit of plan.delivery_units) for (const ref of unit.slice_refs) if (!refs.has(ref)) issues.push(`unit ${unit.id} references unknown slice ${ref}`);
  const unitById = new Map(plan.delivery_units.map((unit) => [unit.id, unit]));
  if (unitById.size !== plan.delivery_units.length) issues.push("delivery unit IDs are duplicated");
  const assigned = new Set<string>();
  for (const unit of plan.delivery_units) for (const ref of unit.slice_refs) {
    if (assigned.has(ref)) issues.push(`slice ${ref} is assigned to multiple delivery units`); else assigned.add(ref);
  }
  for (const ref of refs) if (!assigned.has(ref)) issues.push(`slice ${ref} is not assigned to a delivery unit`);
  const stackedUnits = new Set<string>();
  for (const stack of plan.stacks) {
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
      if (unit.branch_mode === "shared") nodes.push(unitId); else nodes.push(...unit.slice_refs.map((ref) => `${unitId}:${ref}`));
    }
    if (providers.size > 1) issues.push(`stack ${stack.stack_id} cannot mix PR providers`);
    if (nodes.length > MAX_PLAN_STACK_DEPTH) issues.push(`stack ${stack.stack_id} normalized PR depth ${nodes.length} exceeds ${MAX_PLAN_STACK_DEPTH}`);
    const root = unitById.get(stack.units[0]!);
    if (root?.depends_on.length) issues.push(`stack ${stack.stack_id} root unit ${root.id} cannot have a stack parent`);
    for (let index = 1; index < stack.units.length; index++) {
      const current = unitById.get(stack.units[index]!); const prior = stack.units[index - 1]!;
      if (current && (current.depends_on.length !== 1 || current.depends_on[0] !== prior)) issues.push(`stack ${stack.stack_id} unit ${current.id} must depend only on ${prior}`);
    }
  }
  return issues;
}

export function renderStructuredPlanMarkdown(plan: StructuredPlanV1): string {
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
  mkdirSync(dirname(paths.historyMarkdown), { recursive: true });
  atomicWrite(paths.historyMarkdown, markdown, false); atomicWrite(paths.historyData, data, false);
  atomicWrite(paths.latestMarkdown, markdown, true); atomicWrite(paths.latestData, data, true);
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
