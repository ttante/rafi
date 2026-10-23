import { nativeFixtureTurn } from "./helpers/nativeOutput.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { buildTicketsCommand } from "ai-foreman/cli/tickets.js";
import { readInterviewRecords } from "ai-foreman/interviews.js";
import { runTicketPlan } from "../src/ticketPlan.js";
import { buildPlanDoctorCommand, planningSessionAge } from "../src/planDoctor.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";
import { prepareOwnedWrite, finalizePreparedOwnedWrite, readInstallManifest } from "../src/ownership.js";

const proposal = () => ({ version: 1, title: "Plan", markdown: "# Plan", additions: [{ id: "T1", order: 1000, title: "Work", area: "Core", priority: "P1", size: "S", risk: "Medium", summary: "Work", acceptance: ["Works"], required_tests: ["Unit"], likely_files: [], depends_on: [], rollback: "Revert the change" }], edits: [], supersessions: [], state_changes: [], source_reconciliation: [], future_work: [], next: { ticket_ids: [], replace_existing: false } });
const output = (value: unknown) => `RAFI_PROPOSAL_START\n${JSON.stringify(value)}\nRAFI_PROPOSAL_END\nSTEP_STATUS: plan_complete | summary="proposal_ready"`;

for (const scenario of ["tests", "rollback", "priority", "combined", "exhausted", "valid"] as const) test(`ticket planner ${scenario} uses bounded response correction and durable recovery`, async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-plan-repair-"));
  let turns = 0; let closed = false; let recovering = false; let ownedWrites = 0;
  let plannedArtifacts: string[] = [];
  try {
    const config = buildProjectConfig(defaultAnswers());
    const docsRoot = config.docs?.root ?? "docs";
    writeFileSync(join(root, "rafi-config.yaml"), stringify(config));
    if (scenario === "valid") {
      mkdirSync(join(root, docsRoot), { recursive: true });
      writeFileSync(join(root, docsRoot, "rafi-ticket-plan.md"), "valuable preexisting plan\n");
    }
    await buildTicketsCommand().parseAsync(["node", "test", "init", "--project", root, "--app-name", "Repair"]);
    const invalid = proposal();
    if (["tests", "combined"].includes(scenario)) invalid.additions[0]!.required_tests = [];
    if (["rollback", "combined", "exhausted"].includes(scenario)) invalid.additions[0]!.rollback = "";
    if (["priority", "combined"].includes(scenario)) invalid.additions[0]!.priority = "Medium";
    const run = (resumeSession?: string) => runTicketPlan({ project: root, brief: "Plan work", agent: "codex", resumeSession, yes: true,
      beforeApply: (_root, artifacts = []) => {
        ownedWrites++; plannedArtifacts = artifacts;
        assert.equal(artifacts.length, 2);
        for (const path of artifacts) { assert.equal(existsSync(join(root, path)), scenario === "valid" && path.endsWith("/rafi-ticket-plan.md")); prepareOwnedWrite(root, path, "tickets:plan", "plans"); }
      },
      afterApply: (_root, artifacts = []) => {
        assert.deepEqual(artifacts, plannedArtifacts);
        for (const path of artifacts) { assert.equal(existsSync(join(root, path)), true); finalizePreparedOwnedWrite(root, path, "tickets:plan", "plans"); }
      }, createPlanner: async () => ({ runtime: "codex", roleBundle: {} as never, skills: [], log: { write() {} } as never, graphRoot: root,
      builder: { agent: "codex", sessionId: () => "repair-session", events: async function* () {}, close: async () => { closed = true; }, sendTurn: async (instruction, policy) => {
        turns++;
        if (turns > 1) assert.match(instruction, /Correct|corrected/);
        return nativeFixtureTurn(policy, "repair-session", !recovering && (turns === 1 || scenario === "exhausted") ? invalid : proposal(), "codex");
      } },
    }) }, ["--no-grill-me"]);
    if (scenario === "exhausted") {
      await assert.rejects(() => run(), /plan:doctor/);
      assert.equal(turns, 4);
      assert.equal(ownedWrites, 0, "invalid proposals do not dirty installation ownership");
      const record = readInterviewRecords(root).records[0]!;
      assert.equal(record.runtime.sessionId, "repair-session");
      assert.ok(record.failure);
      recovering = true;
      await assert.rejects(() => run(record.runtime.sessionId), /after 3 attempts/);
      assert.equal(turns, 4, "resume retains the exhausted domain-correction budget");
      assert.equal(ownedWrites, 0);
      return;
    } else if (scenario === "priority" || scenario === "combined" || scenario === "tests") {
      await assert.rejects(() => run(), /schema|contract|structured/i);
      assert.equal(turns, 1, "invalid wire contracts never trigger response correction");
      assert.equal(ownedWrites, 0);
      return;
    } else { await run(); assert.equal(turns, scenario === "valid" ? 1 : 2); assert.equal(closed, true); }
    assert.equal(ownedWrites, 1, "preimages are captured exactly once at approved publication");
    assert.deepEqual(readInstallManifest(root)?.files.filter(file => file.category === "plans").map(file => file.path).sort(), [...plannedArtifacts].sort());
    if (scenario === "valid") {
      const latest = readInstallManifest(root)!.files.find(file => file.path.endsWith("/rafi-ticket-plan.md"))!;
      assert.equal(latest.mode, "modified");
      assert.equal(readFileSync(join(root, latest.backup!), "utf8"), "valuable preexisting plan\n");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("planning doctor labels session age", () => {
  assert.equal(planningSessionAge("2026-10-12T10:00:00Z", Date.parse("2026-10-12T12:00:00Z")), "2h ago");
});

test("unattended ticket planning preserves a missing decision without inventing an answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-unattended-ticket-plan-"));
  let turns = 0;
  try {
    writeFileSync(join(root, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())));
    await buildTicketsCommand().parseAsync(["node", "test", "init", "--project", root, "--app-name", "Unattended"]);
    await assert.rejects(() => runTicketPlan({ project: root, brief: "Plan work", agent: "codex", yes: true, createPlanner: async () => ({ runtime: "codex", roleBundle: {} as never, skills: [], log: { write() {} } as never, graphRoot: root,
      builder: { agent: "codex", sessionId: () => "unattended-session", events: async function* () {}, close: async () => {}, sendTurn: async (instruction, policy) => {
        turns++;
        if (turns === 1) return nativeFixtureTurn(policy, "unattended-session", undefined, "codex", { kind: "needs-input", question: "Should I proceed?", choices: ["Yes (Recommended)", "No"] });
        assert.match(instruction, /unattended ticket planning cannot accept/);
        throw new Error("Unexpected automatic continuation");
      } },
    }) }, ["--no-grill-me"]), /resume interactively/);
    assert.equal(turns, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
