import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeStructuredPlan, readAndValidateStructuredPlanPair, regenerateStructuredPlanMarkdown,
  readNamedApprovedPlan, renderStructuredPlanMarkdown, validateMaterializedPlan, writeStructuredPlanArtifacts,
  type StructuredPlanProposalV1,
} from "../src/structuredPlan.js";

function proposal(): StructuredPlanProposalV1 {
  return {
    version: 1, summary: "Ship feature", assumptions: ["GitHub"], implementation_changes: ["Add API", "Add UI"],
    acceptance_criteria: ["Works"], test_plan: ["unit"],
    slices: [
      { local_ref: "S1", title: "API", summary: "API work", acceptance: ["endpoint"], required_tests: ["api test"], likely_files: ["api.ts"], depends_on: [] },
      { local_ref: "S2", title: "UI", summary: "UI work", acceptance: ["screen"], required_tests: ["ui test"], likely_files: ["ui.ts"], depends_on: ["S1"] },
    ],
    delivery_units: [
      { id: "api", slice_refs: ["S1"], branch_mode: "per-ticket", completion: "pr", provider: "github", pr_ready: false, merge_method: "squash", cleanup: false, depends_on: [], dependency_mode: "stack" },
      { id: "ui", slice_refs: ["S2"], branch_mode: "per-ticket", completion: "pr", provider: "github", pr_ready: false, merge_method: "squash", cleanup: false, depends_on: ["api"], dependency_mode: "stack" },
    ], stacks: [{ local_ref: "STACK", name: "Feature", units: ["api", "ui"] }],
  };
}

test("structured plans assign durable identities, retain them on revision, and render deterministically", () => {
  let sequence = 0; const allocate = () => String(++sequence);
  const first = materializeStructuredPlan(proposal(), undefined, allocate);
  const revisedProposal = proposal(); revisedProposal.slices[0]!.retains = first.slices[0]!.slice_ref; revisedProposal.slices[1]!.retains = first.slices[1]!.slice_ref; revisedProposal.stacks[0]!.retains = first.stacks[0]!.stack_id;
  const revised = materializeStructuredPlan(revisedProposal, first, allocate);
  assert.equal(revised.plan_id, first.plan_id); assert.equal(revised.revision, 2);
  assert.deepEqual(revised.slices.map((slice) => slice.slice_ref), first.slices.map((slice) => slice.slice_ref));
  assert.equal(renderStructuredPlanMarkdown(revised), renderStructuredPlanMarkdown(revised));
});

test("paired artifacts reject edited Markdown and can regenerate it from structured data", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-plan-pair-")); let n = 0;
  const plan = materializeStructuredPlan(proposal(), undefined, () => String(++n));
  const paths = writeStructuredPlanArtifacts(root, "docs", plan);
  assert.equal(readAndValidateStructuredPlanPair(paths.latestMarkdown, paths.latestData).content_digest, plan.content_digest);
  writeFileSync(paths.latestMarkdown, `${readFileSync(paths.latestMarkdown, "utf8")}edited\n`);
  assert.throws(() => readAndValidateStructuredPlanPair(paths.latestMarkdown, paths.latestData), /plan pair mismatch/);
  regenerateStructuredPlanMarkdown(paths.latestMarkdown, paths.latestData);
  assert.equal(readAndValidateStructuredPlanPair(paths.latestMarkdown, paths.latestData).plan_id, plan.plan_id);
});

test("normalized per-ticket PR nodes enforce depth five", () => {
  const p = proposal(); p.slices = []; p.delivery_units = []; p.stacks = [{ local_ref: "S", name: "deep", units: ["all"] }];
  for (let i = 0; i < 6; i++) p.slices.push({ local_ref: `S${i}`, title: `T${i}`, summary: "x", acceptance: ["x"], required_tests: ["x"], likely_files: [], depends_on: i ? [`S${i - 1}`] : [] });
  p.delivery_units.push({ id: "all", slice_refs: p.slices.map((slice) => slice.local_ref), branch_mode: "per-ticket", completion: "pr", provider: "github", pr_ready: false, merge_method: "squash", cleanup: false, depends_on: [], dependency_mode: "stack" });
  assert.throws(() => materializeStructuredPlan(p), /normalized PR depth 6 exceeds 5/);
});

test("named revision loads the newest immutable revision of a non-latest lineage", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-plan-lineage-")); let n = 0;
  const first = materializeStructuredPlan(proposal(), undefined, () => `a${++n}`); writeStructuredPlanArtifacts(root, "docs", first);
  const revisedProposal = proposal(); revisedProposal.slices.forEach((slice, index) => { slice.retains = first.slices[index]!.slice_ref; }); revisedProposal.stacks[0]!.retains = first.stacks[0]!.stack_id;
  const second = materializeStructuredPlan(revisedProposal, first, () => `b${++n}`); writeStructuredPlanArtifacts(root, "docs", second);
  const other = materializeStructuredPlan(proposal(), undefined, () => `c${++n}`); writeStructuredPlanArtifacts(root, "docs", other);
  assert.equal(readNamedApprovedPlan(root, "docs", first.plan_id).revision, 2);
  assert.equal(readNamedApprovedPlan(root, "docs", first.plan_id).content_digest, second.content_digest);
});
