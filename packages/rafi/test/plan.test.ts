import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { mergeSkills, type RoleBuilder } from "ai-foreman/agent-run.js";
import {
  buildPlanAgentRunOptions,
  buildPlanInstruction,
  formatPlanValidationFailures,
  isSuccessfulPlanStatus,
  nextPopulateCommand,
  resolveBrief,
  resolvePlanDocsRoot,
  resolvePlanSources,
  runPlanWorkflow,
  stripFinalStepStatusMarker,
  validatePlanMarkdown,
  writePlanArtifacts,
  writeValidatedPlanArtifacts,
  type PlanWorkflowOptions,
} from "../src/plan.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";
import {
  PLAN_PROPOSAL_END,
  PLAN_PROPOSAL_START,
  type StructuredPlanProposalV1,
} from "../src/structuredPlan.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rafi-plan-test-"));
}

function installRafiConfig(dir: string): void {
  writeFileSync(join(dir, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())), "utf8");
}

function validStructuredProposal(): StructuredPlanProposalV1 {
  return {
    version: 1,
    summary: "Ship labels",
    assumptions: ["Use current ticket setup defaults."],
    implementation_changes: ["Add label metadata."],
    acceptance_criteria: ["Labels can be saved."],
    test_plan: ["Run unit tests."],
    slices: [{
      local_ref: "S1",
      title: "Labels",
      summary: "Add label support.",
      acceptance: ["Labels persist."],
      required_tests: ["Unit test label persistence."],
      likely_files: ["src/labels.ts"],
      depends_on: [],
    }],
    delivery_units: [{
      id: "labels",
      slice_refs: ["S1"],
      branch_mode: "per-ticket",
      completion: "none",
      provider: "local",
      pr_ready: false,
      merge_method: "squash",
      cleanup: false,
      depends_on: [],
      dependency_mode: "combine",
    }],
    stacks: [],
  };
}

function planCompleteOutput(proposal: unknown): string {
  return `${PLAN_PROPOSAL_START}\n${JSON.stringify(proposal)}\n${PLAN_PROPOSAL_END}\nSTEP_STATUS: plan_complete | summary="created ticket-maker-ready Rafi plan"`;
}

function fakePlanRun(text: string, sessionId: string): Awaited<ReturnType<NonNullable<PlanWorkflowOptions["runInstruction"]>>> {
  return {
    turn: {
      result: { text, isError: false, numTurns: 1, costUsd: 0 },
      status: { kind: "plan_complete", summary: "created ticket-maker-ready Rafi plan" },
    },
    runtime: "codex",
    model: "test-model",
    sessionId,
    logPath: "",
    roleBundle: {} as never,
    skills: [],
  };
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

test("exhaustive plan run loads grill-me and forbids native interactive questions", () => {
  const instruction = buildPlanInstruction({
    brief: "Add account settings.",
    docsRoot: "docs",
    latestPlanPath: "docs/rafi-plan.md",
    historyDirPath: "docs/rafi-plans",
    planningMode: "exhaustive",
  });
  const opts = buildPlanAgentRunOptions({
    projectDir: "/tmp/project",
    agent: "codex",
    instruction,
    planningMode: "exhaustive",
  });

  assert.deepEqual(opts.extraSkills, ["grill-me"]);
  assert.match(instruction, /complete grill-me skill instructions/);
  assert.match(instruction, /Do not call provider-native, host-native, or runtime interactive tools/);
  assert.match(instruction, /STEP_STATUS: needs_input/);
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

test("plan workflow repairs a malformed structured proposal in the same session", async () => {
  const dir = tempDir();
  installRafiConfig(dir);
  const malformed = validStructuredProposal() as unknown as Record<string, unknown>;
  const units = structuredClone(malformed.delivery_units) as Array<Record<string, unknown>>;
  delete units[0]!.depends_on;
  malformed.delivery_units = units;
  const fixed = validStructuredProposal();
  const instructions: string[] = [];
  const sessions: Array<string | undefined> = [];
  let calls = 0;
  const runInstruction: PlanWorkflowOptions["runInstruction"] = async (options) => {
    calls += 1;
    instructions.push(options.instruction);
    sessions.push(options.resumeSessionId);
    return fakePlanRun(planCompleteOutput(calls === 1 ? malformed : fixed), `session-${calls}`);
  };

  try {
    const outcome = await runPlanWorkflow({
      project: dir,
      brief: "Add labels.",
      yes: true,
      rawArgs: ["--no-grill-me"],
      runInstruction,
    });

    assert.equal(outcome.status, "completed");
    assert.equal(calls, 2);
    assert.equal(sessions[0], undefined);
    assert.equal(sessions[1], "session-1");
    assert.match(instructions[1]!, /delivery unit labels\.depends_on must be a string array/);
    assert.match(instructions[1]!, /STEP_STATUS: plan_complete/);
    assert.ok(outcome.result?.latestData.endsWith("docs/rafi-plan.json"));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("plan workflow handles grill-me needs_input through Rafi and resumes the same planner session", async () => {
  const dir = tempDir();
  installRafiConfig(dir);
  const turns: string[] = [];
  const createCalls: Array<{ extraSkills?: string[] }> = [];
  const createPlanner: PlanWorkflowOptions["createPlanner"] = async (options) => {
    createCalls.push({ extraSkills: options.extraSkills });
    let index = 0;
    const builder = {
      agent: "codex" as const,
      async sendTurn(text: string) {
        turns.push(text);
        index += 1;
        if (index === 1) {
          return {
            text: 'Before planning, pick a path.\nSTEP_STATUS: needs_input | question="Which path?" choices="Recommended path|Alternative|Stop questions and make the plan now"',
            isError: false,
            numTurns: 1,
            costUsd: 0,
          };
        }
        return { text: planCompleteOutput(validStructuredProposal()), isError: false, numTurns: 1, costUsd: 0 };
      },
      sessionId: () => "same-session",
      async *events() {},
      async close() {},
    };
    return {
      builder,
      runtime: "codex",
      model: "test-model",
      roleBundle: {} as never,
      skills: options.extraSkills ?? [],
      log: { write() {} } as never,
    } satisfies RoleBuilder;
  };

  try {
    const outcome = await runPlanWorkflow({
      project: dir,
      brief: "Add labels.",
      yes: true,
      grillMe: true,
      rawArgs: ["--grill-me"],
      createPlanner,
      handleInput: async (input) => ({
        registry: input.registry,
        snapshots: [],
        answer: "Recommended path",
        continuation: "User answer (preserve exactly):\nRecommended path\n\nContinue this same planning session without editing files.",
        cancelled: false,
      }),
    });

    assert.equal(outcome.status, "completed");
    assert.equal(createCalls.length, 1);
    assert.deepEqual(createCalls[0]?.extraSkills, ["grill-me"]);
    assert.equal(turns.length, 2);
    assert.match(turns[1]!, /Recommended path/);
    assert.equal(outcome.result?.sessionId, "same-session");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("plan workflow stops after three unsuccessful structured proposal repairs", async () => {
  const dir = tempDir();
  installRafiConfig(dir);
  const malformed = validStructuredProposal() as unknown as Record<string, unknown>;
  const units = structuredClone(malformed.delivery_units) as Array<Record<string, unknown>>;
  delete units[0]!.depends_on;
  malformed.delivery_units = units;
  let calls = 0;
  const runInstruction: PlanWorkflowOptions["runInstruction"] = async () => {
    calls += 1;
    return fakePlanRun(planCompleteOutput(malformed), `session-${calls}`);
  };

  try {
    const outcome = await runPlanWorkflow({
      project: dir,
      brief: "Add labels.",
      yes: true,
      rawArgs: ["--no-grill-me"],
      runInstruction,
    });

    assert.equal(outcome.status, "failed");
    assert.equal(calls, 4);
    assert.match(outcome.diagnostic ?? "", /invalid structured proposal after 3 repair attempts/);
    assert.match(outcome.resumeCommand ?? "", /--resume-session "session-4"/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
