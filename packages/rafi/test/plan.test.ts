import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { mergeSkills } from "ai-foreman/agent-run.js";
import {
  buildPlanAgentRunOptions,
  buildPlanInstruction,
  nextPopulateCommand,
  resolvePlanDocsRoot,
  stripFinalStepStatusMarker,
  writePlanArtifacts,
} from "../src/plan.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rafi-plan-test-"));
}

test("plan instruction pins grill-me, prd-to-issues guidance, and output contract", () => {
  const instruction = buildPlanInstruction({
    brief: "Add account settings.",
    sources: ["docs/product.md"],
    docsRoot: "docs-rafi",
    latestPlanPath: "docs-rafi/rafi-plan.md",
    historyDirPath: "docs-rafi/rafi-plans",
  });

  assert.match(instruction, /Use the planner role guidance/);
  assert.match(instruction, /Use the grill-me skill explicitly/);
  assert.match(instruction, /Use prd-to-issues only as vertical-slice planning guidance/);
  assert.match(instruction, /Do not create issues\/\*\.md/);
  assert.match(instruction, /Do not edit source files, docs, \.tickets/);
  for (const section of [
    "Goal",
    "Problem Statement",
    "Repo Findings",
    "Locked Decisions",
    "Open Questions",
    "Scope",
    "Out Of Scope",
    "Risks",
    "Rollback Notes",
    "Ticket-Maker Guidance",
  ]) {
    assert.match(instruction, new RegExp(section));
  }
  assert.match(instruction, /branch\/batch strategy for repeated component-library work/);
  assert.match(instruction, /STEP_STATUS: plan_complete/);
});

test("plan agent run options use planner plus grill-me with non-mutating permissions", () => {
  const opts = buildPlanAgentRunOptions({
    projectDir: "/tmp/project",
    agent: "codex",
    instruction: "Plan.",
  });

  assert.equal(opts.role, "planner");
  assert.deepEqual(opts.extraSkills, ["grill-me"]);
  assert.deepEqual(
    mergeSkills(["write-a-prd", "prd-to-issues"], opts.extraSkills),
    ["write-a-prd", "prd-to-issues", "grill-me"],
  );
  assert.equal(opts.sandboxMode, "read-only");
  assert.ok(opts.permissionConfig?.allowTools.includes("Read"));
  assert.ok(opts.permissionConfig?.allowTools.includes("Grep"));
  assert.ok(!opts.permissionConfig?.allowTools.includes("Write"));
  assert.ok(opts.permissionConfig?.escalateTools.includes("Write"));
  assert.ok(opts.permissionConfig?.escalateTools.includes("Edit"));
});

test("plan docs root resolves from rafi-config.yaml or defaults to docs", () => {
  const configured = tempDir();
  const fallback = tempDir();
  try {
    mkdirSync(join(configured, "docs-rafi"));
    writeFileSync(join(configured, "rafi-config.yaml"), stringify({ docs: { root: "docs-rafi" } }), "utf8");

    assert.equal(resolvePlanDocsRoot(configured), "docs-rafi");
    assert.equal(resolvePlanDocsRoot(fallback), "docs");
  } finally {
    rmSync(configured, { recursive: true });
    rmSync(fallback, { recursive: true });
  }
});

test("writePlanArtifacts preserves versioned history and refreshes latest", () => {
  const dir = tempDir();
  try {
    const first = writePlanArtifacts(
      dir,
      "docs-rafi",
      "# First\nSTEP_STATUS: plan_complete | summary=\"done\"",
      new Date("2026-01-02T03:04:05.006Z"),
    );
    const second = writePlanArtifacts(
      dir,
      "docs-rafi",
      "# Second\n",
      new Date("2026-01-03T03:04:05.006Z"),
    );

    assert.equal(first.historyRel, "docs-rafi/rafi-plans/2026-01-02T03-04-05-006Z.md");
    assert.ok(existsSync(join(dir, first.historyRel)));
    assert.ok(existsSync(join(dir, second.historyRel)));
    assert.equal(readFileSync(join(dir, first.historyRel), "utf8"), "# First\n");
    assert.equal(readFileSync(join(dir, second.latestRel), "utf8"), "# Second\n");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("writePlanArtifacts rejects output paths that escape through symlinks", () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    mkdirSync(join(dir, "docs-rafi"));
    symlinkSync(outside, join(dir, "docs-rafi", "rafi-plans"));

    assert.throws(
      () => writePlanArtifacts(dir, "docs-rafi", "# Plan\n"),
      /plan output must stay inside the repository/,
    );
  } finally {
    rmSync(dir, { recursive: true });
    rmSync(outside, { recursive: true });
  }
});

test("stripFinalStepStatusMarker removes only the final marker", () => {
  const stripped = stripFinalStepStatusMarker("Keep this line\nSTEP_STATUS: plan_complete | summary=\"done\"\n");
  assert.equal(stripped, "Keep this line");
});

test("nextPopulateCommand points tickets populate at the latest plan", () => {
  const dir = tempDir();
  try {
    assert.equal(
      nextPopulateCommand(dir, "docs-rafi/rafi-plan.md"),
      `rafi tickets populate --project "${dir}" --sources "docs-rafi/rafi-plan.md"`,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});
