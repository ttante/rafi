import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { buildTicketsCommand } from "ai-foreman/cli/tickets.js";
import { readInterviewRecords } from "ai-foreman/interviews.js";
import { runTicketPlan } from "../src/ticketPlan.js";
import { buildPlanDoctorCommand, planningSessionAge } from "../src/planDoctor.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";

const proposal = () => ({ version: 1, title: "Plan", markdown: "# Plan", additions: [{ id: "T1", order: 1000, title: "Work", area: "Core", priority: "P1", size: "S", risk: "Medium", summary: "Work", acceptance: ["Works"], required_tests: ["Unit"], likely_files: [], depends_on: [], rollback: "Revert the change" }], edits: [], supersessions: [], state_changes: [], source_reconciliation: [], future_work: [], next: { ticket_ids: [], replace_existing: false } });
const output = (value: unknown) => `RAFI_PROPOSAL_START\n${JSON.stringify(value)}\nRAFI_PROPOSAL_END\nSTEP_STATUS: plan_complete | summary="proposal_ready"`;

for (const scenario of ["tests", "rollback", "priority", "combined", "exhausted", "valid"] as const) test(`ticket planner ${scenario} uses bounded response correction and durable recovery`, async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-plan-repair-"));
  let turns = 0; let closed = false; let recovering = false; let ownedWrites = 0;
  try {
    writeFileSync(join(root, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())));
    await buildTicketsCommand().parseAsync(["node", "test", "init", "--project", root, "--app-name", "Repair"]);
    const invalid = proposal();
    if (["tests", "combined", "exhausted"].includes(scenario)) invalid.additions[0]!.required_tests = [];
    if (["rollback", "combined", "exhausted"].includes(scenario)) invalid.additions[0]!.rollback = "";
    if (["priority", "combined", "exhausted"].includes(scenario)) invalid.additions[0]!.priority = "Medium";
    const run = (resumeSession?: string) => runTicketPlan({ project: root, brief: "Plan work", agent: "codex", resumeSession, yes: true, beforeApply: () => { ownedWrites++; }, createPlanner: async () => ({ runtime: "codex", roleBundle: {} as never, skills: [], log: { write() {} } as never, graphRoot: root,
      builder: { agent: "codex", sessionId: () => "repair-session", events: async function* () {}, close: async () => { closed = true; }, sendTurn: async instruction => {
        turns++;
        if (turns > 1) assert.match(instruction, /Correct|corrected/);
        return { text: output(!recovering && (turns === 1 || scenario === "exhausted") ? invalid : proposal()), isError: false, numTurns: 1, costUsd: 0 };
      } },
    }) }, ["--no-grill-me"]);
    if (scenario === "exhausted") {
      await assert.rejects(() => run(), /plan:doctor/);
      assert.equal(turns, 4);
      assert.equal(ownedWrites, 0, "invalid proposals do not dirty installation ownership");
      const record = readInterviewRecords(root).records[0]!;
      assert.equal(record.runtime.sessionId, "repair-session");
      assert.ok(record.failure);
      let resumed: string | undefined;
      await buildPlanDoctorCommand({ select: async records => records[0]?.id, resume: async (_root, saved) => { resumed = saved.id; recovering = true; await run(saved.runtime.sessionId); } }).parseAsync(["node", "test", root]);
      assert.equal(resumed, record.id);
      assert.equal(readInterviewRecords(root).records[0]?.status, "completed");
    } else { await run(); assert.equal(turns, scenario === "valid" ? 1 : 2); assert.equal(closed, true); }
    assert.equal(ownedWrites, 1, "preimages are captured exactly once at approved publication");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("planning doctor labels session age", () => {
  assert.equal(planningSessionAge("2026-10-12T10:00:00Z", Date.parse("2026-10-12T12:00:00Z")), "2h ago");
});

test("unattended ticket planning corrects an unexpected provider question", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-unattended-ticket-plan-"));
  let turns = 0;
  try {
    writeFileSync(join(root, "rafi-config.yaml"), stringify(buildProjectConfig(defaultAnswers())));
    await buildTicketsCommand().parseAsync(["node", "test", "init", "--project", root, "--app-name", "Unattended"]);
    await runTicketPlan({ project: root, brief: "Plan work", agent: "codex", yes: true, createPlanner: async () => ({ runtime: "codex", roleBundle: {} as never, skills: [], log: { write() {} } as never, graphRoot: root,
      builder: { agent: "codex", sessionId: () => "unattended-session", events: async function* () {}, close: async () => {}, sendTurn: async instruction => {
        turns++;
        if (turns === 1) return { text: 'STEP_STATUS: needs_input | question="Should I proceed?" choices="Yes (Recommended)|No"', isError: false, numTurns: 1, costUsd: 0 };
        assert.match(instruction, /unattended ticket planning cannot accept/);
        return { text: output(proposal()), isError: false, numTurns: 1, costUsd: 0 };
      } },
    }) }, ["--no-grill-me"]);
    assert.equal(turns, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
