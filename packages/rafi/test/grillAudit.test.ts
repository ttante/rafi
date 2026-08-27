import test from "node:test";
import assert from "node:assert/strict";
import {
  GRILL_AUDIT_END,
  GRILL_AUDIT_START,
  GRILL_ME_STOP_CHOICE,
  buildAuditAnswersContinuation,
  candidateDigest,
  collectGrillAuditAnswers,
  defaultGrillVerificationState,
  isGrillMeTextQuestion,
  parseGrillAuditVerdict,
  recordTextGrillAnswer,
  runIndependentGrillAudit,
} from "../src/grillAudit.js";
import type { RoleBuilder } from "ai-foreman/agent-run.js";

const choices = ["Use SQLite (Recommended)", "Use Postgres", GRILL_ME_STOP_CHOICE];

test("textual grill-me qualification rejects generic, malformed, recommendation-less, and stop-less prompts", () => {
  assert.equal(isGrillMeTextQuestion("Which store?", choices), true);
  assert.equal(isGrillMeTextQuestion("Do you want to implement?", ["Yes", "No"]), false);
  assert.equal(isGrillMeTextQuestion("Which store?", ["Use SQLite", "Use Postgres", GRILL_ME_STOP_CHOICE]), false);
  assert.equal(isGrillMeTextQuestion("Which store?", choices.slice(0, 2)), false);
  assert.equal(isGrillMeTextQuestion("", choices), false);
});

test("custom and stop textual answers count, while empty answers do not", () => {
  const initial = defaultGrillVerificationState(true);
  const custom = recordTextGrillAnswer(initial, { question: "Which store?", choices, answer: "Use Redis" });
  assert.equal(custom.qualified, true);
  assert.equal(custom.state.validAnsweredQuestionCount, 1);
  const stop = recordTextGrillAnswer(initial, { question: "Which store?", choices, answer: GRILL_ME_STOP_CHOICE });
  assert.equal(stop.qualified, true);
  assert.equal(recordTextGrillAnswer(initial, { question: "Which store?", choices, answer: "" }).qualified, false);
});

test("audit verdict parsing is strict and bounded", () => {
  const complete = parseGrillAuditVerdict(`${GRILL_AUDIT_START}\n{"status":"complete","evidence":"All product choices are explicit in the brief."}\n${GRILL_AUDIT_END}`);
  assert.equal(complete.status, "complete");
  const needs = parseGrillAuditVerdict(`${GRILL_AUDIT_START}\n${JSON.stringify({ status: "needs_user_input", questions: [{ id: "retention", question: "How long?", recommendation: "30 days", rationale: "Matches the brief", alternatives: ["7 days", "Never"] }] })}\n${GRILL_AUDIT_END}`);
  assert.equal(needs.status, "needs_user_input");
  assert.throws(() => parseGrillAuditVerdict(`commentary\n${GRILL_AUDIT_START}\n{"status":"complete","evidence":"ok"}\n${GRILL_AUDIT_END}`));
  assert.throws(() => parseGrillAuditVerdict(`${GRILL_AUDIT_START}\n{"status":"complete","evidence":""}\n${GRILL_AUDIT_END}`));
  assert.throws(() => parseGrillAuditVerdict(`${GRILL_AUDIT_START}\n{"status":"complete","evidence":"looks fine"}\n${GRILL_AUDIT_END}`));
});

test("independent audit uses a fresh read-only grill-me session and fails closed on malformed output", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const createAuditor = async (options: Record<string, unknown>) => {
    calls.push(options);
    return fakeRole("not a verdict");
  };
  const result = await runIndependentGrillAudit({
    projectDir: "/tmp", originalRequest: "Plan it", knownDecisions: {}, repositoryContext: {}, candidate: { b: 2, a: 1 },
    runtime: "codex", model: "gpt-test", effort: "high", createAuditor: createAuditor as never,
  });
  assert.equal(result.state.auditStatus, "failed");
  assert.equal(result.state.auditAttempted, true);
  assert.equal(calls[0]?.sandboxMode, "read-only");
  assert.equal(calls[0]?.yes, true);
  assert.deepEqual(calls[0]?.extraSkills, ["grill-me"]);
  assert.equal(candidateDigest({ a: 1, b: 2 }), candidateDigest({ b: 2, a: 1 }));
});

test("audit questions resume at the first unanswered item and stop immediately", async () => {
  const base = {
    ...defaultGrillVerificationState(true), auditAttempted: true as const, auditStatus: "needs_user_input" as const,
    pendingQuestions: [
      { id: "one", question: "First?", recommendation: "A", rationale: "A is safest", alternatives: ["B"] },
      { id: "two", question: "Second?", recommendation: "C", rationale: "C is safest", alternatives: ["D"] },
    ],
    answers: [{ questionId: "one", answer: "A (Recommended)" }],
  };
  const seen: string[] = [];
  const state = await collectGrillAuditAnswers(base, async (question, rendered) => {
    seen.push(question.id);
    assert.equal(rendered.at(-1), GRILL_ME_STOP_CHOICE);
    return GRILL_ME_STOP_CHOICE;
  });
  assert.deepEqual(seen, ["two"]);
  assert.equal(state.stopped, true);
  assert.equal(state.answers.length, 2);
  assert.match(buildAuditAnswersContinuation(state), /User stopped further questions: yes/);
});

test("cancelled audit input is persisted as interrupted", async () => {
  const base = {
    ...defaultGrillVerificationState(true), auditAttempted: true as const, auditStatus: "needs_user_input" as const,
    pendingQuestions: [
      { id: "one", question: "First?", recommendation: "A", rationale: "A is safest", alternatives: ["B"] },
    ],
  };
  const transitions: string[] = [];
  const state = await collectGrillAuditAnswers(base, async () => undefined, (_state, event, questionId) => {
    transitions.push(`${event}:${questionId}`);
  });
  assert.equal(state.auditStatus, "interrupted");
  assert.deepEqual(transitions, ["audit_interrupted:one"]);
});

function fakeRole(text: string): RoleBuilder {
  return {
    runtime: "codex", roleBundle: {} as never, skills: ["grill-me"], log: { write() {} } as never,
    builder: {
      agent: "codex", async sendTurn() { return { text, isError: false, numTurns: 1, costUsd: 0 }; },
      sessionId: () => "audit-session", async *events() {}, async close() {},
    },
  };
}
