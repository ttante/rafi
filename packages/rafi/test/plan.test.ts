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
  formatPlanValidationFailures,
  isSuccessfulPlanStatus,
  nextPopulateCommand,
  resolveBrief,
  resolvePlanDocsRoot,
  resolvePlanSources,
  stripFinalStepStatusMarker,
  validatePlanMarkdown,
  writePlanArtifacts,
  writeValidatedPlanArtifacts,
} from "../src/plan.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rafi-plan-test-"));
}

test("standard plan instruction excludes grill-me and keeps the output contract", () => {
  const instruction = buildPlanInstruction({
    brief: "Add account settings.",
    sources: ["docs/product.md"],
    docsRoot: "docs-rafi",
    latestPlanPath: "docs-rafi/rafi-plan.md",
    historyDirPath: "docs-rafi/rafi-plans",
  });

  assert.match(instruction, /Use the planner role guidance/);
  assert.match(instruction, /standard focused planning conversation/);
  assert.doesNotMatch(instruction, /complete grill-me skill instructions/);
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

test("standard plan run uses planner without grill-me and non-mutating permissions", () => {
  const opts = buildPlanAgentRunOptions({
    projectDir: "/tmp/project",
    agent: "codex",
    instruction: "Plan.",
  });

  assert.equal(opts.role, "planner");
  assert.deepEqual(opts.extraSkills, []);
  assert.deepEqual(
    mergeSkills(["write-a-prd", "prd-to-issues"], opts.extraSkills),
    ["write-a-prd", "prd-to-issues"],
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

test("plan sources prefer an explicit flag and otherwise carry create planning sources", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "rafi-config.yaml"), stringify({ planning: { sources: ["docs/brief.md", "notes/**"] } }), "utf8");
    assert.deepEqual(resolvePlanSources(dir), ["docs/brief.md", "notes/**"]);
    assert.deepEqual(resolvePlanSources(dir, ["manual.md"]), ["manual.md"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("plan success status accepts only plan_complete", () => {
  assert.equal(isSuccessfulPlanStatus("plan_complete"), true);
  assert.equal(isSuccessfulPlanStatus("done"), false);
  assert.equal(isSuccessfulPlanStatus("qa_pass"), false);
});

test("plan validation accepts required sections and ticket-maker guidance", () => {
  const missing = validatePlanMarkdown(`
## Goal
Ship account settings.

## Problem Statement
Users cannot update account settings.

## Repo Findings
The account area is in app/account.

## Locked Decisions
Use the existing form stack.

## Open Questions
None.

## Scope
Settings page and save path.

## Out of Scope
Billing settings.

## Risks
Validation regressions.

## Rollback Notes
Revert the settings route.

## Ticket-Maker Guidance
- Ticket slices: account settings route, save API, tests.
- Dependencies: save API before UI submit wiring.
- Acceptance criteria: users can save valid changes and see validation errors.
- Required tests: unit tests and an integration smoke test.
- Likely files: app/account/settings.tsx, server/account.ts.
- Branch/batch strategy: use one branch per slice and batch repeated component-library form updates.
STEP_STATUS: plan_complete | summary="created ticket-maker-ready Rafi plan"
`);

  assert.deepEqual(missing, []);
});

test("plan validation rejects missing sections and ticket-maker guidance items", () => {
  const missing = validatePlanMarkdown(`
## Goal
Ship account settings.

## Ticket-Maker Guidance
- Ticket slices: account settings route.
`);

  assert.ok(missing.includes("section: Problem Statement"));
  assert.ok(missing.includes("section: Repo Findings"));
  assert.ok(missing.includes("Ticket-Maker Guidance: dependencies"));
  assert.ok(missing.includes("Ticket-Maker Guidance: acceptance criteria"));
  assert.ok(missing.includes("Ticket-Maker Guidance: required tests"));
  assert.ok(missing.includes("Ticket-Maker Guidance: likely files"));
  assert.ok(missing.includes("Ticket-Maker Guidance: branch/batch strategy"));
  assert.match(formatPlanValidationFailures(missing), /missing section: Problem Statement/);
});

test("plan validation accepts a singular Dependency Graph heading", () => {
  const plan = `
## Goal
Ship account settings.

## Problem Statement
Settings cannot currently be changed.

## Repo Findings
The account route exists.

## Locked Decisions
Save settings immediately.

## Open Questions
None.

## Scope
Settings page and save path.

## Out of Scope
Billing settings.

## Risks
Validation regressions.

## Rollback Notes
Revert the settings route.

## Ticket-Maker Guidance
### Ticket Slices
- Account settings route, save API, and tests.

### Dependency Graph
Save API before UI submit wiring.

### Acceptance
Users can save valid changes and see validation errors.

### Tests
Unit tests and an integration smoke test.

### Files
app/account/settings.tsx, server/account.ts.

### Branch / Batch Strategy
Use one branch per slice and batch repeated component-library form updates.
`;

  assert.deepEqual(validatePlanMarkdown(plan), []);
});

test("validated plan writes reject incomplete plans before creating artifacts", () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => writeValidatedPlanArtifacts(dir, "docs-rafi", "## Goal\nShip account settings.\n"),
      /planner returned an incomplete plan/,
    );
    assert.equal(existsSync(join(dir, "docs-rafi", "rafi-plan.md")), false);
    assert.equal(existsSync(join(dir, "docs-rafi", "rafi-plans")), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("resolveBrief reports --brief and --brief-file conflict before empty brief validation", async () => {
  const dir = tempDir();
  try {
    const briefFile = join(dir, "brief.md");
    writeFileSync(briefFile, "Use file\n", "utf8");

    await assert.rejects(
      () => resolveBrief({ brief: "", briefFile }),
      /choose either --brief or --brief-file/,
    );
  } finally {
    rmSync(dir, { recursive: true });
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
