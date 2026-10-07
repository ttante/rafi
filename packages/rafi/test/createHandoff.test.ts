import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { createInterviewRecord } from "ai-foreman/interviews.js";
import { buildPopulateInstruction, resolvePopulationPlan, resolvePopulateSources } from "ai-foreman/cli/tickets.js";
import { loadTicketSetupConfig } from "ai-foreman/tickets/setup-config.js";
import { loadSourceRegistry } from "ai-foreman/sources/source-registry.js";
import { runCreateTicketHandoff } from "../src/index.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";
import { runPlanWorkflow } from "../src/plan.js";
import { PLAN_PROPOSAL_END, PLAN_PROPOSAL_START } from "../src/structuredPlan.js";

const CANCEL = Symbol("cancel");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rafi-create-handoff-test-"));
}

function prompts(values: unknown[]) {
  return {
    select: async () => values.shift(),
    isCancel: (value: unknown) => value === CANCEL,
  };
}

function parent(dir: string) {
  return createInterviewRecord({ workflow: "create", invocation: { projectDir: dir }, checkpoint: "handoff" });
}

function completedPlanOutput(): string {
  const proposal = {
    version: 1,
    summary: "Ship the requested feature.",
    assumptions: [],
    implementation_changes: ["Implement the feature."],
    acceptance_criteria: ["The feature works."],
    test_plan: ["Run the focused tests."],
    slices: [{
      local_ref: "S1",
      title: "Implement feature",
      summary: "Implement the feature from the supplied requirements.",
      acceptance: ["The feature works."],
      required_tests: ["Run the focused tests."],
      likely_files: ["src/feature.ts"],
      depends_on: [],
    }],
    delivery_units: [{
      id: "feature", slice_refs: ["S1"], branch_mode: "per-ticket", completion: "none", provider: "local",
      pr_ready: false, merge_method: "squash", cleanup: false, depends_on: [], dependency_mode: "combine",
    }],
    stacks: [],
  };
  return `${PLAN_PROPOSAL_START}\n${JSON.stringify(proposal)}\n${PLAN_PROPOSAL_END}\nSTEP_STATUS: plan_complete | summary="created ticket-maker-ready Rafi plan"`;
}

test("create hands the explicitly selected runtime to its child plan and checkpoints it", async () => {
  const dir = tempDir();
  const config = buildProjectConfig(defaultAnswers());
  let agent: string | undefined;
  const result = await runCreateTicketHandoff(dir, config, defaultAnswers(), false, {
    planningMode: "standard", interview: parent(dir),
  }, {
    interactive: true,
    prompts: prompts(["plan", "codex"]),
    runPlan: (async (options: { agent?: string }) => {
      agent = options.agent;
      return { status: "cancelled" };
    }) as never,
  });
  assert.equal(agent, "codex");
  assert.equal(result.interview?.answers.childPlanRuntime, "codex");
  assert.equal(result.interview?.checkpoint, "child-plan-paused");
});

test("create uses its sole configured runtime without another selection", async () => {
  const dir = tempDir();
  const answers = { ...defaultAnswers(), useClaude: false };
  let agent: string | undefined;
  await runCreateTicketHandoff(dir, buildProjectConfig(answers), answers, false, {
    planningMode: "standard", interview: parent(dir),
  }, {
    interactive: true,
    prompts: prompts(["plan"]),
    runPlan: (async (options: { agent?: string }) => {
      agent = options.agent;
      return { status: "cancelled" };
    }) as never,
  });
  assert.equal(agent, "codex");
});

test("cancelling create's runtime selection launches no planner and pauses the interview", async () => {
  const dir = tempDir();
  let calls = 0;
  const result = await runCreateTicketHandoff(dir, buildProjectConfig(defaultAnswers()), defaultAnswers(), false, {
    planningMode: "standard", interview: parent(dir),
  }, {
    interactive: true,
    prompts: prompts(["plan", CANCEL]),
    runPlan: (async () => { calls += 1; return { status: "completed" }; }) as never,
  });
  assert.equal(calls, 0);
  assert.equal(result.journeyComplete, false);
  assert.equal(result.interview?.status, "paused");
  assert.equal(result.interview?.checkpoint, "child-plan-runtime-cancelled");
});

test("create preserves a local source through a docs-rafi plan into Ticket Maker context", async () => {
  const dir = tempDir();
  const answers = { ...defaultAnswers(), docsRoot: "docs-rafi", planningSources: "FEATURES.md" };
  const config = buildProjectConfig(answers);
  try {
    writeFileSync(join(dir, "FEATURES.md"), "# Features\n\nShip the requested feature.\n", "utf8");
    writeFileSync(join(dir, "rafi-config.yaml"), stringify(config), "utf8");

    const result = await runCreateTicketHandoff(dir, config, answers, false, {
      planningMode: "standard",
      interview: parent(dir),
    }, {
      interactive: true,
      prompts: prompts(["plan", "codex", "setup"]),
      runPlan: (async (options: Parameters<typeof runPlanWorkflow>[0]) => runPlanWorkflow({
        ...options,
        brief: "Ship the requested feature.",
        yes: true,
        runInstruction: async () => ({
          turn: {
            result: { text: completedPlanOutput(), isError: false, numTurns: 1, costUsd: 0 },
            status: { kind: "plan_complete", summary: "created ticket-maker-ready Rafi plan" },
          },
          runtime: "codex",
          model: "test-model",
          sessionId: "planner-session",
          logPath: "",
          roleBundle: {} as never,
          skills: [],
        }),
      })) as never,
    });

    assert.equal(result.journeyComplete, true);
    const registry = loadSourceRegistry(dir).registry;
    assert.deepEqual(registry.pending ?? [], []);
    assert.equal(registry.entries[0]?.locator.path, "FEATURES.md");
    assert.ok(registry.entries[0]?.versions[0]?.snapshot_path);

    assert.deepEqual(loadTicketSetupConfig(dir)?.sources, [{ type: "local", paths: ["FEATURES.md"] }]);
    const progressDoc = "docs-rafi/ticket-progress.md";
    const ticketsConfig = { paths: { progressDoc } } as never;
    const contextSources = resolvePopulateSources(dir, undefined, ticketsConfig);
    assert.deepEqual(contextSources, ["FEATURES.md"]);
    const approvedPlan = resolvePopulationPlan(dir, contextSources!, ticketsConfig);
    assert.equal(approvedPlan.path, "docs-rafi/rafi-plan.json");
    const instruction = buildPopulateInstruction(approvedPlan.path, contextSources, progressDoc);
    assert.match(instruction, /Approved structured Rafi plan[\s\S]*docs-rafi\/rafi-plan\.json/);
    assert.match(instruction, /Original context source hints:[\s\S]*FEATURES\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create snapshots an external local source and carries it into Ticket Maker context", async () => {
  const dir = tempDir();
  const externalDir = tempDir();
  const externalSource = join(externalDir, "FEATURES.md");
  const answers = { ...defaultAnswers(), docsRoot: "docs-rafi", planningSources: externalSource };
  const config = buildProjectConfig(answers);
  try {
    writeFileSync(externalSource, "# External features\n\nShip the requested feature.\n", "utf8");
    writeFileSync(join(dir, "rafi-config.yaml"), stringify(config), "utf8");

    const result = await runCreateTicketHandoff(dir, config, answers, false, {
      planningMode: "standard",
      interview: parent(dir),
    }, {
      interactive: true,
      prompts: prompts(["plan", "codex", "setup"]),
      runPlan: (async (options: Parameters<typeof runPlanWorkflow>[0]) => runPlanWorkflow({
        ...options,
        brief: "Ship the requested feature.",
        yes: true,
        runInstruction: async () => ({
          turn: {
            result: { text: completedPlanOutput(), isError: false, numTurns: 1, costUsd: 0 },
            status: { kind: "plan_complete", summary: "created ticket-maker-ready Rafi plan" },
          },
          runtime: "codex",
          model: "test-model",
          sessionId: "planner-session",
          logPath: "",
          roleBundle: {} as never,
          skills: [],
        }),
      })) as never,
    });

    assert.equal(result.journeyComplete, true);
    const registry = loadSourceRegistry(dir).registry;
    const snapshotPath = registry.entries[0]?.locator.path;
    assert.match(snapshotPath ?? "", /^\.tickets\/imports\/local-/);
    assert.ok(existsSync(join(dir, snapshotPath!)));
    assert.equal(readFileSync(join(dir, snapshotPath!), "utf8"), readFileSync(externalSource, "utf8"));

    const progressDoc = "docs-rafi/ticket-progress.md";
    const ticketsConfig = { paths: { progressDoc } } as never;
    const contextSources = resolvePopulateSources(dir, undefined, ticketsConfig);
    assert.deepEqual(contextSources, [snapshotPath]);
    const approvedPlan = resolvePopulationPlan(dir, contextSources!, ticketsConfig);
    assert.equal(approvedPlan.path, "docs-rafi/rafi-plan.json");
    const instruction = buildPopulateInstruction(approvedPlan.path, contextSources, progressDoc);
    assert.match(instruction, /Approved structured Rafi plan[\s\S]*docs-rafi\/rafi-plan\.json/);
    assert.match(instruction, new RegExp(snapshotPath!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
});
