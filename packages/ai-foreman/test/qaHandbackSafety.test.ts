import { admitFixtureWork } from "./helpers/workAdmission.js";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSessionRefV1, QaFailureReportV1 } from "rafi-spec";
import { BUILDER_QA_REMEDIATION_START as START, BUILDER_QA_REMEDIATION_END as END } from "rafi-spec";
import { BuilderEventQueue } from "../src/activity.js";
import { RecoveringAdapter } from "../src/adapters/recovering.js";
import { CurrentWorkflowGuardAdapter } from "../src/branch/currentGuard.js";
import { ContinuityAdapter } from "../src/continuity.js";
import { RoleStatusAdapter } from "../src/statusReporter.js";
import type { BuilderAdapter, BuilderEvent, TurnResult } from "../src/adapters/types.js";
import { QaFailureDeliveryService, type QaFailureDeliveryInput } from "../src/qaFailureDelivery.js";
import { createQaFindingRefs, canonicalJson } from "../src/qaProtocolV2.js";
import { captureFrozenQaSourceAsync } from "../src/qaSnapshot.js";
import { WorkflowDb } from "../src/workflowDb.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";

const report: QaFailureReportV1 = { version: 1, summary: "Needs a fix", checks_run: [{ check: "static", outcome: "failed", evidence: "missing guard" }], findings: [{ id: "QA-1", requirement: "guard", locations: ["source.txt"], problem: "missing guard", evidence: "source", expected: "guard", fix_direction: "add guard", verification: ["inspect"] }], observations: [] };
const ticket: TicketDef = { id: "T1", order: 1, title: "Guard", area: "core", priority: "P2", size: "S", risk: "Low", depends_on: [], summary: "Guard", acceptance: ["guard"], required_tests: ["inspect"], likely_files: ["source.txt"] };

async function fixture(provider: "claude" | "codex" = "codex", responseText?: (text: string, call: number) => string) {
  const root = mkdtempSync(join(tmpdir(), "rafi-handback-safety-"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "source.txt"), "before\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
  const source = await captureFrozenQaSourceAsync(root);
  const db = new WorkflowDb(root); db.ensureRun("run"); admitFixtureWork(db,"run",ticket.id, ticket);
  const digest = db.putEvidence("qa", Buffer.from(canonicalJson(report)));
  const refs = createQaFindingRefs({ runId: "run", ticketId: "T1", reviewAttemptId: "review", reportDigest: digest, rawFindingIds: ["QA-1"] });
  let head = db.qaTicketHead("run", "T1");
  head = db.transitionQa("run", "T1", head.revision, { type: "source-frozen", sourceStateDigest: source.digest });
  head = db.transitionQa("run", "T1", head.revision, { type: "review-ready", reviewBasisDigest: "basis", sessionGeneration: 0 });
  db.beginQaReviewAttempt({ attemptId: "review", runId: "run", ticketId: "T1", reviewNumber: 1, cycle: 1, remediationGeneration: 0, sourceDigest: source.digest });
  head = db.transitionQa("run", "T1", head.revision, { type: "turn-intended", slot: "initial" });
  db.commitQaFailureAttempt("review", { reportDigest: digest, runId: "run", ticketId: "T1", reviewNumber: 1, sourceStateDigest: source.digest, reviewBasisDigest: "basis", report }, ["QA-1"], refs.map(r => r.findingKey), report.summary, head.revision);
  db.close();
  const queue = new BuilderEventQueue();
  let ref: ProviderSessionRefV1 = { version: 1, provider, sessionId: "session", role: "builder", stream: "builder", generation: 0, cwd: root, configRoot: root, ticketId: "T1", source: "observed", createdAt: new Date(0).toISOString() };
  const calls: string[] = [];
  const adapter: BuilderAdapter = { agent: provider, sessionId: () => ref.sessionId, sessionRef: () => ref, observeEvents: listener => queue.observe(listener), events: () => queue, close: async () => { queue.close(); }, sendTurn: async prompt => {
    calls.push(prompt);
    const handoff_id = /QA failure handoff ID: ([a-f0-9]{64})/.exec(prompt)![1];
    let text = `${START}\n${JSON.stringify({ version: 3, handoff_id, summary: "Reported", findings: [{ finding_key: refs[0]!.findingKey, raw_id: "QA-1", disposition: "disputed", changes: ["No code change required"], evidence: "Actual evidence", verification: [{ check: "inspect", outcome: "passed", evidence: "guard exists" }] }], observations: [] })}\n${END}\nSTEP_STATUS: done | summary="reported"`;
    text = responseText?.(text, calls.length) ?? text;
    const result: TurnResult = { text, rawResponse: text, cleanedResponse: text, hostInstruction: prompt, providerInstruction: prompt, isError: false, numTurns: 1, costUsd: 0, turnId: `turn-${calls.length}`, providerMetadata: { provider, sessionId: ref.sessionId, sessionRef: ref } };
    queue.push({ kind: "turn-complete", result, turnId: result.turnId }); return result;
  } };
  const input: QaFailureDeliveryInput = { projectDir: root, runId: "run", ticket, builderWorktree: root, report, reportDigest: digest, reviewAttemptId: "review", reviewNumber: 1, reviewedSourceStateDigest: source.digest, reviewBasisDigest: "basis", remediationGeneration: 0, latestBuilderResult: "implemented", history: [] };
  return { root, input, adapter, calls, queue, setRef: (next: ProviderSessionRefV1) => { ref = next; }, run: () => new QaFailureDeliveryService().deliver(input, { adapter: () => adapter, sessionStrategy: "compact" }), close: () => rmSync(root, { recursive: true, force: true }) };
}

for (const provider of ["claude", "codex"] as const) for (const scenario of ["valid", "repair", "repair-tool", "provider-error", "missing-observation"] as const) test(`${provider} CLI adapter stack preserves handback ${scenario}`, async () => {
  const delta = { version: 1, decisions: [], constraints: [], discoveries: [], completedActions: [], evidence: [], failures: [], blockers: [], openWork: ["Independent QA"], nextAction: "Independent QA" };
  const f = await fixture(provider, (text, call) => `${scenario.startsWith("repair") && call === 1 ? "Unwanted prologue\n" : ""}${text.replace("STEP_STATUS:", `RAFI_CONTINUITY_DELTA: ${JSON.stringify(delta)}\nSTEP_STATUS:`)}`);
  const policies: Array<Parameters<BuilderAdapter["sendTurn"]>[1]> = [];
  const original = f.adapter.sendTurn;
  f.adapter.sendTurn = async (text, policy) => {
    policies.push(policy);
    if (scenario === "repair-tool" && policies.length === 2) f.queue.push({ kind: "tool", name: "Read", input: {} });
    const result = await original(text, policy);
    if (scenario === "provider-error") result.isError = true;
    return result;
  };
  if (scenario === "missing-observation") f.adapter.observeEvents = undefined;
  const recovering = new RecoveringAdapter({ initial: new CurrentWorkflowGuardAdapter(f.adapter, f.root), runtime: provider, enabled: true, allowSwitch: true, label: "Builder", choose: async () => { assert.fail("handback must not prompt for hidden retry"); }, recreate: async () => { throw new Error("handback must not recreate provider"); } });
  const continuous = new ContinuityAdapter({ adapter: recovering, projectDir: f.root, runId: "run", role: "builder", settings: { role: "builder", source: "project", make: provider, model: "default", reasoning: "default", fast: false, session_strategy: "compact", settings_revision: 1, display_session_cost: false, auto_compact_threshold_percent: 50, compact_maximum: 1 } });
  const adapter = new RoleStatusAdapter(continuous, () => {}, () => {});
  const observed: BuilderEvent[] = [];
  const pump = (async () => { for await (const event of adapter.events()) observed.push(event); })();
  try {
    const result = await new QaFailureDeliveryService().deliver(f.input, { adapter: () => adapter, sessionStrategy: "compact", prepareBoundary: async current => current });
    assert.equal(result.outcome, scenario === "repair-tool" ? "response-invalid" : scenario === "provider-error" || scenario === "missing-observation" ? "delivery-uncertain" : "remediation-reported", result.detail);
    assert.equal(f.calls.length, scenario === "missing-observation" ? 0 : scenario.startsWith("repair") ? 2 : 1);
    assert.ok(policies.every(policy => policy?.handback));
    if (policies.length === 2) assert.equal(policies[1]?.responseOnly, true);
    const db = new WorkflowDb(f.root);
    try {
      assert.equal(db.qaTicketHead("run", "T1").passCertificateId, undefined);
      if (result.ok) assert.equal(db.hasUncheckpointedRoleTurn("run", "builder"), false, "accepted handback publishes continuity through outer wrappers");
    } finally { db.close(); }
  } finally { await adapter.close(); await pump; f.close(); }
  assert.equal(observed.filter(event => event.kind === "turn-complete").length, f.calls.length, "journal observation preserves the normal event consumer");
});

for (const provider of ["claude", "codex"] as const) test(`${provider} handback accepts refreshed identity timestamps and preserves independent QA`, async () => {
  const f = await fixture(provider);
  try {
    const original = f.adapter.sendTurn;
    f.adapter.sendTurn = async prompt => { const result = await original(prompt); f.setRef({ ...f.adapter.sessionRef!()!, validatedAt: new Date().toISOString() }); return result; };
    const result = await f.run(); assert.equal(result.outcome, "remediation-reported", result.detail);
    const replay = await new QaFailureDeliveryService().deliver(f.input, { adapter: () => undefined, sessionStrategy: "compact" });
    assert.equal(replay.ok, true, "completed receipt replay does not require a live Builder session");
    assert.equal(replay.turnRecordId, result.turnRecordId); assert.equal(f.calls.length, 1);
    const db = new WorkflowDb(f.root);
    try { assert.equal(db.qaTicketHead("run", "T1").passCertificateId, undefined); assert.equal(db.qaDeliveryTurns(result.operationId!).length, 1); } finally { db.close(); }
  } finally { f.close(); }
});

for (const defect of ["missing-observation", "missing-terminal", "duplicate-terminal", "foreign-terminal", "foreign-terminal-metadata", "foreign-config"] as const) test(`delivery fails closed for ${defect}`, async () => {
  const f = await fixture();
  try {
    const observe = f.adapter.observeEvents!;
    if (defect === "missing-observation") f.adapter.observeEvents = undefined;
    else f.adapter.observeEvents = listener => observe(event => {
      if (event.kind === "turn-complete") {
        if (defect === "missing-terminal") return;
        if (defect === "foreign-terminal") { listener({ ...event, turnId: "foreign" }); return; }
        if (defect === "foreign-terminal-metadata") { listener({ ...event, result: { ...event.result, providerMetadata: { ...event.result.providerMetadata!, sessionId: "foreign" } } }); return; }
        if (defect === "duplicate-terminal") listener(event);
      }
      listener(event);
    });
    if (defect === "foreign-config") f.setRef({ ...f.adapter.sessionRef!()!, configRoot: tmpdir() });
    const result = await f.run();
    assert.equal(result.ok, false); assert.equal(result.outcome, "delivery-uncertain");
    assert.ok(f.calls.length <= 1, "identity/observation defects never trigger repair");
    await f.run(); assert.ok(f.calls.length <= 1, "uncertain dispatch is never replayed");
  } finally { f.close(); }
});

test("canonical existing symlink aliases identify the same worktree", async () => {
  const f = await fixture(); const alias = `${f.root}-alias`;
  try { symlinkSync(f.root, alias); f.setRef({ ...f.adapter.sessionRef!()!, cwd: alias, configRoot: alias }); assert.equal((await f.run()).ok, true); }
  finally { rmSync(alias, { force: true }); f.close(); }
});

for (const defect of ["foreign-review", "stale-generation", "superseded-report"] as const) test(`handback rejects ${defect} before preparing or dispatching Builder`, async () => {
  const f = await fixture();
  try {
    const db = new WorkflowDb(f.root);
    try {
      if (defect === "foreign-review") {
        admitFixtureWork(db,"other-run","T1",ticket);
        db.beginQaReviewAttempt({ attemptId: "foreign-review", runId: "other-run", ticketId: "T1", reviewNumber: 1, cycle: 1, remediationGeneration: 0, sourceDigest: f.input.reviewedSourceStateDigest });
        db.finishQaReviewAttempt("foreign-review", { status: "failed", reportDigest: f.input.reportDigest });
        f.input.reviewAttemptId = "foreign-review";
      } else if (defect === "stale-generation") f.input.remediationGeneration = 3;
      else db.setQaReportDisposition(f.input.reportDigest, "superseded", "A newer review owns this work");
    } finally { db.close(); }
    let preparations = 0;
    await assert.rejects(new QaFailureDeliveryService().deliver(f.input, { adapter: () => f.adapter, sessionStrategy: "compact", prepareBoundary: async adapter => { preparations++; return adapter; } }), /binding|occurrence/);
    assert.equal(preparations, 0); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test("budget zero dispatches nothing; scoped operator grant is consumed atomically once", async () => {
  const f = await fixture(); f.input.maxRemediationOperations = 0;
  try {
    await assert.rejects(f.run(), /budget exhausted/); assert.equal(f.calls.length, 0);
    const db = new WorkflowDb(f.root);
    try { f.input.authorizationId = db.authorizeQaRemediation("run", "T1", "review", "Operator authorized one additional attempt"); } finally { db.close(); }
    const result = await f.run(); assert.equal(result.ok, true, result.detail);
    const checked = new WorkflowDb(f.root);
    try { assert.equal(checked.qaAutomaticRemediationCount("run", "T1"), 0); assert.throws(() => checked.atomic(() => checked.reserveQaRemediation("run", "T1", "review", "duplicate", 0, f.input.authorizationId)), /already consumed/); } finally { checked.close(); }
  } finally { f.close(); }
});

test("questions survive restart, reject foreign/empty answers, and consume identical answers idempotently", async () => {
  const f = await fixture();
  try {
    f.adapter.sendTurn = async prompt => { f.calls.push(prompt); const text = 'STEP_STATUS: needs_input | question="Which approved registry may I use?"'; const result: TurnResult = { text, isError: false, numTurns: 1, costUsd: 0, turnId: "question", providerMetadata: { provider: "codex", sessionId: "session", sessionRef: f.adapter.sessionRef!() } }; f.queue.push({ kind: "turn-complete", result, turnId: result.turnId }); return result; };
    assert.equal((await f.run()).outcome, "needs-input");
    assert.equal((await f.run()).outcome, "needs-input"); assert.equal(f.calls.length, 1);
    const db = new WorkflowDb(f.root);
    try {
      const decision = db.pendingHumanDecisions("run")[0]!;
      assert.throws(() => db.answerHumanDecision("foreign", decision.decisionId, "answer", new Date(), "approved registry"), /not found/);
      assert.throws(() => db.answerHumanDecision("run", decision.decisionId, "answer"), /actual decision/);
      const answer = db.answerHumanDecision("run", decision.decisionId, "answer", new Date(), "Use the already configured internal registry");
      assert.equal(answer.answer, "Use the already configured internal registry");
      assert.deepEqual(db.answerHumanDecision("run", decision.decisionId, "answer", new Date(), answer.answer), answer);
      assert.throws(() => db.answerHumanDecision("run", decision.decisionId, "answer", new Date(), "different answer"), /already been answered/);
      db.clearQaRemediationStop("run", "T1", "Validated operator recovery after answering");
      assert.deepEqual(db.answerHumanDecision("run", decision.decisionId, "answer", new Date(), answer.answer), answer);
    } finally { db.close(); }
  } finally { f.close(); }
});

test("one observation subscriber does not steal terminal events from another consumer", async () => {
  const queue = new BuilderEventQueue(); const seen: BuilderEvent[] = [];
  const unsubscribe = queue.observe(event => seen.push(event));
  const event: BuilderEvent = { kind: "tool", name: "Read", input: {} };
  queue.push(event); assert.deepEqual((await queue[Symbol.asyncIterator]().next()).value, event); assert.deepEqual(seen, [event]);
  unsubscribe(); queue.push(event); assert.equal(seen.length, 1); queue.close();
});

test("a supplied operator answer must match a durable decision in the current ticket", async () => {
  const f = await fixture();
  try {
    f.input.operatorAnswer = { decisionId: "invented", answer: "Invented authorization" };
    await assert.rejects(f.run(), /does not match an answered decision/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test("read-only audit correlates V3 turns, preserves database bytes, and never calls transport acceptance a QA pass", async () => {
  const f = await fixture();
  try {
    const result = await f.run(); assert.equal(result.ok, true);
    const path = join(f.root, ".rafi/recovery.sqlite3");
    const before = readFileSync(path);
    const script = fileURLToPath(new URL("../../../scripts/audit-qa-handback.mjs", import.meta.url));
    const audit = JSON.parse(execFileSync(process.execPath, [script, f.root], { encoding: "utf8" }));
    assert.deepEqual(readFileSync(path), before);
    assert.equal(audit.coherentReadTransaction, true); assert.equal(audit.counts.deliveryTurns, 1);
    assert.equal(audit.handoffs[0].qaApproved, false); assert.equal(audit.handoffs[0].contractAccepted, true);
    assert.equal(audit.handoffs[0].promptEvidenceMatches, true);
    assert.equal(audit.handoffs[0].turns[0].turnRecordId, result.turnRecordId);
    assert.equal(audit.handoffs[0].knownPauseSeconds, null);
    assert.equal(audit.counts.qaConfirmedResolvedOccurrences, 0);
    assert.equal(audit.counts.deliveryInvocations, 1);
    assert.ok(audit.handoffs[0].invocations[0].phases.some((phase: { name: string }) => phase.name === "initial-work-and-validation"));
  } finally { f.close(); }
});

test("audit includes failed preparation and resumed invocations without exposing prompt secrets or counting QA setup as report repair", async () => {
  const f = await fixture();
  try {
    f.input.latestBuilderResult = "token=private-prompt-secret";
    await assert.rejects(new QaFailureDeliveryService().deliver(f.input, { adapter: () => f.adapter, sessionStrategy: "compact", beforeTurn: async () => { throw new Error("preparation failed"); } }), /preparation failed/);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.run()).ok, true);
    const db = new WorkflowDb(f.root);
    try {
      for (const slot of ["initial", "session-initialization", "resume:acknowledgement", "qa-report:correction-1"]) db.beginQaTurn({ version: 2, operationId: slot, runId: "run", ticketId: "T1", reviewNumber: 1, sessionGeneration: 0, slot, sourceStateDigest: f.input.reviewedSourceStateDigest, reviewBasisDigest: "basis", providerSession: { ...f.adapter.sessionRef!()!, version: 2, role: "qa", stream: "qa", validatedAt: new Date(0).toISOString() }, instructionDigest: "fixture", intendedAt: new Date(0).toISOString() });
    } finally { db.close(); }
    const script = fileURLToPath(new URL("../../../scripts/audit-qa-handback.mjs", import.meta.url));
    const output = execFileSync(process.execPath, [script, f.root], { encoding: "utf8" });
    assert.doesNotMatch(output, /private-prompt-secret/);
    const audit = JSON.parse(output);
    assert.equal(audit.counts.deliveryInvocations, 2); assert.equal(audit.counts.failedInvocations, 1);
    assert.equal(audit.counts.qaReportCorrections, 1); assert.equal(audit.counts.qaSetupTurns, 1); assert.equal(audit.counts.qaAcknowledgementTurns, 1);
    assert.equal(audit.invocations.length, 2);
    assert.ok(audit.invocations.some((invocation: { status: string }) => invocation.status === "failed"));
  } finally { f.close(); }
});

for (const phase of ["afterResponseStored", "beforeOutcomeCommit"] as const) test(`${phase} crash retains provider bytes and prevents replay`, async () => {
  const f = await fixture();
  try {
    const service = new QaFailureDeliveryService({ [phase]: () => { throw new Error(`fault:${phase}`); } });
    await assert.rejects(service.deliver(f.input, { adapter: () => f.adapter, sessionStrategy: "compact" }), /fault:/);
    const db = new WorkflowDb(f.root);
    try {
      const handoff = db.qaFailureHandoffs("run", "T1")[0]!;
      const turn = db.qaDeliveryTurns(handoff.operationId)[0]!;
      assert.ok(turn.rawResponseDigest); assert.ok(db.getEvidence(turn.rawResponseDigest));
      assert.equal(db.qaTicketHead("run", "T1").state, "remediation-intended");
      assert.equal(db.qaAutomaticRemediationCount("run", "T1"), 1);
    } finally { db.close(); }
    assert.equal((await f.run()).outcome, "delivery-uncertain"); assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test("process death after committed intent survives WAL recovery with zero blind redispatch", async () => {
  const f = await fixture();
  try {
    const serviceUrl = new URL("../src/qaFailureDelivery.ts", import.meta.url).href;
    const script = `import { QaFailureDeliveryService } from ${JSON.stringify(serviceUrl)};
      const input = JSON.parse(process.argv[1]);
      const ref = { version: 1, provider: 'codex', sessionId: 'session', role: 'builder', stream: 'builder', generation: 0, cwd: input.builderWorktree, configRoot: input.projectDir, source: 'observed', createdAt: new Date(0).toISOString() };
      const adapter = { agent: 'codex', sessionId: () => ref.sessionId, sessionRef: () => ref, observeEvents: () => () => {}, sendTurn: async () => { throw Error('must not dispatch'); } };
      await new QaFailureDeliveryService({ afterIntent: () => process.kill(process.pid, 'SIGKILL') }).deliver(input, { adapter: () => adapter, sessionStrategy: 'compact' });`;
    assert.throws(() => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(f.input)], { stdio: "pipe" }), error => (error as { signal?: string }).signal === "SIGKILL");
    const db = new WorkflowDb(f.root);
    try { const handoff = db.qaFailureHandoffs("run", "T1")[0]!; assert.equal(db.qaDeliveryTurns(handoff.operationId)[0]!.status, "intended"); assert.equal(db.qaAutomaticRemediationCount("run", "T1"), 1); }
    finally { db.close(); }
    assert.equal((await f.run()).outcome, "delivery-uncertain"); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test("competing delivery entry points share one durable intent and never duplicate Builder work", async () => {
  const f = await fixture(); f.input.maxRemediationOperations = 1;
  try {
    const outcomes = await Promise.allSettled([f.run(), f.run()]);
    assert.ok(outcomes.some(result => result.status === "fulfilled" && result.value.ok));
    assert.equal(f.calls.length, 1);
    const db = new WorkflowDb(f.root);
    try { assert.equal(db.qaRemediationAttempts("run", "T1").length, 1); assert.equal(db.qaAutomaticRemediationCount("run", "T1"), 1); }
    finally { db.close(); }
  } finally { f.close(); }
});
