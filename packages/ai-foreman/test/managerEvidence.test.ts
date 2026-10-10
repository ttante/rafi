import { makeLegacyWorkFixture } from "./helpers/legacyWork.js";
import { admitFixtureWork } from "./helpers/workAdmission.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { validateManagerEvidenceRequestV2, validateQaFailureReport } from "rafi-spec";
import { WorkflowDb } from "../src/workflowDb.js";
import { ManagerEvidenceService } from "../src/managerEvidence.js";
import { evidenceDigest, ManagerEvidenceArtifacts, renderEvidenceText } from "../src/managerEvidenceArtifacts.js";
import { readQaEvidenceSnapshot } from "../src/qaEvidenceReader.js";
import { buildQaTimeline } from "../src/qaTimeline.js";
import { buildManagerEvidencePacketV2, MANAGER_PACKET_MAX_BYTES } from "../src/managerPacket.js";
import { completeManagerHostEvidence, executeManagerHostCommand } from "../src/cli/manager.js";

function fixture() {
  const project = mkdtempSync(join(tmpdir(), "manager-evidence-"));
  const db = new WorkflowDb(project);
  db.createRun({ runId: "run-a", kind: "build", originalWork: {}, state: { tickets: ["T001", "T002"] } });
  db.createRun({ runId: "run-b", kind: "build", originalWork: {}, state: { tickets: ["T001"] } });
  const largeReport = { version: 1, summary: "Retained multibyte report", checks_run: [{ check: "tests", outcome: "failed", evidence: "failed assertion" }], findings: Array.from({ length: 5 }, (_, index) => ({ id: `QA-${index + 1}`, requirement: "tests pass", locations: ["a.ts"], problem: "🧪é".repeat(2000), evidence: "assertion failed", expected: "pass", fix_direction: "repair", verification: ["run tests"] })), observations: ["é".repeat(1500)] };
  assert.equal(validateQaFailureReport(largeReport).valid, true);
  const append = (runId: string, workId: string, reviewNumber: number, body = JSON.stringify(largeReport)) => {
    admitFixtureWork(db,runId,workId);
    const attemptId = `${runId}-${workId}-${reviewNumber}`;
    const reportDigest = db.putEvidence("qa", Buffer.from(body));
    db.beginQaReviewAttempt({ attemptId, runId, ticketId: workId, reviewNumber, cycle: reviewNumber, remediationGeneration: 0, sourceDigest: "source" });
    db.finishQaReviewAttempt(attemptId, { status: "failed", reportDigest });
    const report = db.recordQaReport({ runId, ticketId: workId, reviewNumber, sourceStateDigest: "source", reviewBasisDigest: "basis", reportDigest, report: JSON.parse(body) }, []);
    return { attemptId, occurrenceId: report.reportOccurrenceId, reportDigest, body };
  };
  return { project, db, append, close: () => { db.close(); rmSync(project, { recursive: true, force: true }); } };
}

test("large multibyte report chunks and host rendering preserve exact retained bytes and packet limit", () => {
  const f = fixture(); const service = new ManagerEvidenceService(f.project);
  try {
    const report = f.append("run-a", "T001", 1);
    const page = service.execute({ version: 2, requestId: "report", operation: { kind: "get_qa_report", runId: "run-a", workId: "T001", attemptId: report.attemptId, occurrenceId: report.occurrenceId } });
    assert.equal(page.availability, "present");
    assert.ok(Buffer.byteLength(buildManagerEvidencePacketV2(page, "Show the complete report")) <= MANAGER_PACKET_MAX_BYTES);
    const longQuestionPacket = buildManagerEvidencePacketV2(page, "Show the complete report. ".repeat(10000));
    assert.ok(Buffer.byteLength(longQuestionPacket) <= MANAGER_PACKET_MAX_BYTES);
    assert.ok(longQuestionPacket.includes((page.items[0] as { handle: string }).handle));
    const largeMetadataPacket = buildManagerEvidencePacketV2({ ...page, omissions: ["Legacy gap ".repeat(10000)] }, "Show the complete report");
    assert.ok(Buffer.byteLength(largeMetadataPacket) <= MANAGER_PACKET_MAX_BYTES);
    assert.ok(largeMetadataPacket.includes((page.items[0] as { handle: string }).handle));
    const chunks = [...page.items]; let cursor = page.nextCursor;
    while (cursor) { const next = service.more(cursor); chunks.push(...next.items); cursor = next.nextCursor; }
    const typed = chunks as Array<{ body: string; handle: string; offset: number; returnedBytes: number; rawDigest: string; identity: Record<string, string> }>;
    assert.equal(typed.map(chunk => chunk.body).join(""), report.body);
    assert.equal(typed[0]!.rawDigest, evidenceDigest(report.body));
    let offset = 0;
    for (const chunk of typed) { assert.equal(chunk.offset, offset); assert.equal(Buffer.byteLength(chunk.body), chunk.returnedBytes); offset += chunk.returnedBytes; assert.equal(chunk.identity.occurrenceId, report.occurrenceId); }
    assert.equal(service.artifacts.bytes(typed[0]!.handle).toString(), report.body);
    let rendered = "";
    assert.equal(executeManagerHostCommand(service, `/qa-report run-a T001 ${report.attemptId}`, text => { rendered += text; }), true);
    assert.ok(rendered.includes(report.body));
  } finally { service.close(); f.close(); }
});

test("stable pages pin dispositions and bytes while reviews append, reject cursor tampering and expire explicitly", () => {
  const f = fixture(); let now = 0; const service = new ManagerEvidenceService(f.project, () => now, 100);
  try {
    const reports = Array.from({ length: 12 }, (_, index) => f.append("run-a", "T001", index + 1, '{"summary":"same","findings":[]}'));
    const first = service.execute({ version: 2, requestId: "list", operation: { kind: "list_qa_attempts", runId: "run-a", workId: "T001" } });
    assert.equal(first.items.length, 10); assert.ok(first.nextCursor);
    f.append("run-a", "T001", 13);
    f.db.setQaReportDisposition(reports[11]!.occurrenceId, "superseded", "later evidence");
    const last = service.more(first.nextCursor!);
    assert.equal(last.items.length, 2);
    assert.equal((last.items[1] as { reports: Array<{ disposition: string }> }).reports[0]!.disposition, "open");
    assert.equal(service.more(`${first.nextCursor}x`).error, "invalid_cursor");
    const reordered = service.execute({ version: 2, requestId: "reordered", operation: { workId: "T001", runId: "run-a", cursor: first.nextCursor, kind: "list_qa_attempts" } });
    assert.equal(reordered.error, undefined); assert.deepEqual(reordered.items, last.items);
    assert.equal(service.execute({ version: 2, requestId: "foreign", operation: { kind: "list_qa_attempts", runId: "run-b", workId: "T001", cursor: first.nextCursor } }).error, "invalid_cursor");
    assert.equal(service.execute({ version: 2, requestId: "foreign-work", operation: { kind: "list_qa_attempts", runId: "run-a", workId: "T002", snapshotId: first.snapshotId } }).error, "invalid_scope");
    const pinnedReport = service.execute({ version: 2, requestId: "pinned", operation: { kind: "get_qa_report", runId: "run-a", workId: "T001", attemptId: reports[0]!.attemptId, occurrenceId: reports[0]!.occurrenceId, snapshotId: first.snapshotId } });
    assert.equal(pinnedReport.availability, "present");
    now = 101; assert.equal(service.more(first.nextCursor!).error, "snapshot_expired");
  } finally { service.close(); f.close(); }
});

test("repeated reports retain occurrence identity and cannot cross run/work/attempt scope", () => {
  const f = fixture(); const service = new ManagerEvidenceService(f.project);
  try {
    const a = f.append("run-a", "T001", 1, '{"summary":"same","findings":[]}');
    const b = f.append("run-b", "T001", 1, a.body);
    assert.equal(a.reportDigest, b.reportDigest); assert.notEqual(a.occurrenceId, b.occurrenceId);
    for (const operation of [
      { kind: "get_qa_report" as const, runId: "run-a", workId: "T001", attemptId: a.attemptId, occurrenceId: b.occurrenceId },
      { kind: "get_qa_report" as const, runId: "run-b", workId: "T001", attemptId: a.attemptId, occurrenceId: b.occurrenceId },
      { kind: "get_qa_evidence" as const, runId: "run-a", workId: "T001", attemptId: a.attemptId, occurrenceId: a.occurrenceId, evidenceRef: { kind: "turn_response" as const, id: b.reportDigest } },
    ]) { const page = service.execute({ version: 2, requestId: "scope", operation }); assert.equal(page.availability, "missing"); assert.deepEqual(page.items, []); }
  } finally { service.close(); f.close(); }
});

test("evidence inspection preserves database bytes and exposes historical conflicts without admission", () => {
  const f = fixture();
  try {
    f.append("run-a", "FOREIGN", 1, '{"summary":"historical conflict","findings":[]}');
    f.db.close();
    const path = join(f.project, ".rafi/recovery.sqlite3");
    makeLegacyWorkFixture(path);
    const before = evidenceDigest(readFileSync(path));
    const service = new ManagerEvidenceService(f.project);
    try {
      const page = service.execute({ version: 2, requestId: "work", operation: { kind: "list_build_work", runId: "run-a" } });
      const foreign = page.items.find(item => (item as { workId: string }).workId === "FOREIGN") as { conflictingHistorical: boolean; admitted: boolean };
      assert.equal(foreign.conflictingHistorical, true); assert.equal(foreign.admitted, false);
      service.execute({ version: 2, requestId: "timeline", operation: { kind: "get_qa_timeline", runId: "run-a", workId: "FOREIGN" } });
      assert.equal(evidenceDigest(readFileSync(path)), before);
    } finally { service.close(); }
  } finally { rmSync(f.project, { recursive: true, force: true }); }
});

test("missing, legacy and corrupt databases remain distinct and reads never migrate", () => {
  const project = mkdtempSync(join(tmpdir(), "manager-evidence-legacy-"));
  try {
    assert.equal(readQaEvidenceSnapshot(project, "run").availability, "missing");
    mkdirSync(join(project, ".rafi")); const path = join(project, ".rafi/recovery.sqlite3");
    const db = new Database(path); db.exec("CREATE TABLE workflow_runs(run_id TEXT,state_json TEXT); INSERT INTO workflow_runs VALUES('run','{}')"); db.close();
    const before = readFileSync(path);
    assert.equal(readQaEvidenceSnapshot(project, "run").availability, "unsupported_legacy");
    assert.deepEqual(readFileSync(path), before);
    const legacyColumns = new Database(path); legacyColumns.exec("CREATE TABLE qa_review_attempts(old_run TEXT,record_json TEXT)"); legacyColumns.close();
    const legacySnapshot = readQaEvidenceSnapshot(project, "run");
    assert.equal(legacySnapshot.availability, "unsupported_legacy");
    assert.ok(legacySnapshot.gaps.includes("qa_review_attempts: unsupported legacy columns"));
    assert.equal(legacySnapshot.rows.workflow_runs?.length, 1);
    const corrupt = new Database(path); corrupt.exec("UPDATE workflow_runs SET state_json='invalid'"); corrupt.close();
    assert.equal(readQaEvidenceSnapshot(project, "run").availability, "corrupt");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("display redaction/control escaping preserves protected bytes and discloses separate digests", () => {
  const artifacts = new ManagerEvidenceArtifacts();
  const raw = Buffer.from("finding must remain\npassword=hunter2 \u001b[2J 🧪");
  const metadata = artifacts.create({ runId: "run", workId: "ticket", attemptId: "attempt", occurrenceId: "occurrence" }, raw);
  assert.deepEqual(artifacts.bytes(metadata.handle, true), raw);
  const rendered = artifacts.bytes(metadata.handle).toString();
  assert.match(rendered, /finding must remain/); assert.doesNotMatch(rendered, /hunter2|\u001b/); assert.match(rendered, /\\u001b/);
  assert.notEqual(metadata.rawDigest, metadata.renderedDigest); assert.equal(metadata.redactions.length, 2);
});

test("strict V2 schemas reject unknown fields, paths and SQL", () => {
  const request = { version: 2, requestId: "test", operation: { kind: "list_qa_attempts", runId: "run", workId: "ticket" } };
  assert.equal(validateManagerEvidenceRequestV2(request).valid, true);
  for (const operation of [{ ...request.operation, sql: "SELECT *" }, { ...request.operation, workId: "../foreign" }, { ...request.operation, path: "/tmp/file" }]) assert.equal(validateManagerEvidenceRequestV2({ ...request, operation }).valid, false);
});

test("quoted credentials and complete Authorization values are redacted with original offsets", () => {
  const raw = '🧪 finding unchanged\n{"password":"quoted-secret", "api_key":"sk-overlapping12345", "summary":"retain this"}\nAuthorization: Bearer fake_token\nnext finding unchanged';
  const rendered = renderEvidenceText(raw);
  assert.doesNotMatch(rendered.text, /quoted-secret|overlapping12345|Bearer|fake_token/);
  assert.ok(rendered.text.startsWith('🧪 finding unchanged\n'));
  assert.ok(rendered.text.includes('"summary":"retain this"'));
  assert.ok(rendered.text.endsWith('\nnext finding unchanged'));
  assert.deepEqual(rendered.redactions.map(span => raw.slice(span.start, span.end)), ['password":"quoted-secret"', 'api_key":"sk-overlapping12345"', 'Authorization: Bearer fake_token']);
  const artifacts = new ManagerEvidenceArtifacts();
  const artifact = artifacts.create({ runId: "run", workId: "work", attemptId: "attempt", occurrenceId: "occurrence" }, Buffer.from(raw));
  assert.equal(artifacts.chunks(artifact.handle, 4).map(chunk => chunk.body).join(""), rendered.text);
  assert.equal(artifacts.bytes(artifact.handle, true).toString(), raw);
  assert.equal(artifact.rawDigest, evidenceDigest(raw));
  const digestHeader='Authorization: Digest username="private-user", nonce="private-nonce", response="private-response"\nnext finding unchanged';
  const header=renderEvidenceText(digestHeader);
  assert.equal(header.text,'[REDACTED]\nnext finding unchanged');
  assert.equal(header.redactions.length,1);
  assert.equal(digestHeader.slice(header.redactions[0]!.start,header.redactions[0]!.end),digestHeader.split('\n')[0]);
  const url='Finding at https://user:password=private@public.example/path remains relevant';
  assert.equal(renderEvidenceText(url).text,'Finding at https://[REDACTED]@public.example/path remains relevant');
  assert.equal(renderEvidenceText('https://user:password=private@public.example/path?password=query-secret').text,'https://[REDACTED]@public.example/path?[REDACTED]');
  for (const secret of ['nested secret', 'nested "quoted" secret', 'nested secret\\']) {
    const serialized = JSON.stringify({ summary: `before ${JSON.stringify({ password: secret, api_key: secret })} after` });
    const nested = renderEvidenceText(serialized);
    assert.doesNotMatch(nested.text, /nested|secret/);
    assert.ok(nested.text.includes('before ')); assert.ok(nested.text.includes(' after'));
    assert.equal(nested.redactions.length, 2);
  }
});

test("report packets and default host rendering redact quoted credentials without altering raw export", () => {
  const f = fixture(), service = new ManagerEvidenceService(f.project);
  try {
    const body = JSON.stringify({ summary: 'Authorization: Bearer fake_token', observations: [JSON.stringify({ password: 'nested-secret' })], findings: [], password: 'quoted-secret', api_key: 'fake-api-key' });
    const report = f.append("run-a", "T001", 1, body);
    const page = service.execute({ version: 2, requestId: "redaction", operation: { kind: "get_qa_report", runId: "run-a", workId: "T001", attemptId: report.attemptId, occurrenceId: report.occurrenceId } });
    const packet = buildManagerEvidencePacketV2(page, "report");
    assert.doesNotMatch(packet, /fake_token|quoted-secret|fake-api-key|nested-secret/);
    let output = "";
    executeManagerHostCommand(service, `/qa-report run-a T001 ${report.attemptId}`, text => { output += text; });
    assert.doesNotMatch(output, /fake_token|quoted-secret|fake-api-key|nested-secret/);
    assert.equal(service.artifacts.bytes((page.items[0] as { handle: string }).handle, true).toString(), body);
  } finally { service.close(); f.close(); }
});

test("one-shot lists and timelines expand all pinned pages and oversized metadata", () => {
  const f = fixture(), service = new ManagerEvidenceService(f.project);
  try {
    for (let i = 1; i <= 12; i++) f.append("run-a", "T001", i, JSON.stringify({ summary: "retained", findings: [{ id: "QA-1", requirement: "keep", problem: "large metadata ".repeat(4000), verification: ["check"] }] }));
    f.db.planOperation({runId:"run-a",idempotencyKey:"large-metadata",kind:"build-assignment",intent:{ticketId:"T001",password:"metadata-secret",note:"large metadata ".repeat(4000)}});
    f.db.ensureHumanDecision({ runId: "run-a", decisionKey: "oversized", interruptionId: "ticket:T001", prompt: "large metadata ".repeat(4000), choices: [{ id: "answer", label: "Answer" }] });
    for (const command of ["/qa-attempts run-a T001", "/qa-timeline run-a T001"]) {
      let output = "";
      executeManagerHostCommand(service, command, text => { output += text; }, true);
      const page = JSON.parse(output);
      assert.equal(page.complete, true);
      assert.equal(page.nextCursor, undefined);
      assert.doesNotMatch(output, /metadataArtifact|\/artifact|\/more|metadata-secret/);
      if (command.includes("attempts")) assert.equal(page.items.length, 12);
      else assert.ok(output.includes("large metadata ".repeat(4000)));
    }
  } finally { service.close(); f.close(); }
});

test("one-shot output reports snapshot expiry without mixing in a refreshed retrieval", () => {
  const f = fixture(); let now = 0;
  const service = new ManagerEvidenceService(f.project, () => now, 100);
  try {
    for (let i = 1; i <= 12; i++) f.append("run-a", "T001", i, '{"summary":"retained","findings":[]}');
    const first = service.execute({ version: 2, requestId: "list", operation: { kind: "list_qa_attempts", runId: "run-a", workId: "T001" } });
    now = 101;
    const result = completeManagerHostEvidence(service, first);
    assert.equal(result.snapshotId, first.snapshotId);
    assert.equal(result.items.length, 10);
    assert.equal(result.complete, false);
    assert.equal(result.error, "snapshot_expired");
  } finally { service.close(); f.close(); }
});

test("identity-based raw export resolves a scoped occurrence and discloses exact digest", () => {
  const f = fixture(), service = new ManagerEvidenceService(f.project); let path: string | undefined;
  try {
    const report = f.append("run-a", "T001", 1, '{"summary":"retained","password":"protected-value","findings":[]}');
    let output = "";
    executeManagerHostCommand(service, `/qa-export run-a T001 ${report.attemptId} ${report.occurrenceId}`, text => { output += text; }, true);
    path = /exported to (.+)\n/.exec(output)![1]!;
    assert.equal(readFileSync(path).toString(), report.body);
    assert.ok(output.includes(report.reportDigest));
    assert.ok(output.includes(report.occurrenceId));
    assert.doesNotMatch(output, /protected-value/);
    assert.throws(() => executeManagerHostCommand(service, `/qa-export run-b T001 ${report.attemptId}`, () => {}, true), /not retained/);
  } finally { if (path) rmSync(join(path, ".."), { recursive: true, force: true }); service.close(); f.close(); }
});

test("timeline counts reviews per ticket, keeps interrupted/pending/pass and recurrence distinct", () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 5; i++) f.append("run-a", "T001", i, JSON.stringify({ summary: "repeat", findings: [{ id: `QA-${i}`, requirement: "test", locations: ["a.ts"], problem: "missing test", verification: ["run test"] }] }));
    f.append("run-a", "T002", 1, '{"summary":"one","findings":[]}');
    for (const [reviewNumber, status] of [[6, "passed"], [7, "interrupted"], [8, "started"]] as const) {
      f.db.beginQaReviewAttempt({ attemptId: `attempt-${reviewNumber}`, runId: "run-a", ticketId: "T001", reviewNumber, cycle: reviewNumber, remediationGeneration: 0, sourceDigest: `source-${reviewNumber}` });
      f.db.finishQaReviewAttempt(`attempt-${reviewNumber}`, { status });
    }
    const snapshot = readQaEvidenceSnapshot(f.project, "run-a");
    const one = buildQaTimeline(snapshot, "T001"); const two = buildQaTimeline(snapshot, "T002");
    assert.equal(one.counters.failedReviews, 5); assert.equal(two.counters.failedReviews, 1);
    assert.equal(one.counters.passedReviews, 1); assert.equal(one.counters.interruptedReviews, 1); assert.equal(one.counters.pendingReviews, 1);
    const reports = one.events.filter(event => event.kind === "report") as Array<{ correlations: Array<{ label: string }> }>;
    assert.equal(reports[0]!.correlations[0]!.label, "newly_observed"); assert.equal(reports[1]!.correlations[0]!.label, "possibly_recurring");
  } finally { f.close(); }
});

test("corrupt retained findings remain inspectable without crashing timeline rendering", () => {
  const f = fixture(); const service = new ManagerEvidenceService(f.project);
  try {
    f.append("run-a", "T001", 1, '{"summary":"corrupt legacy finding","findings":[null,42,[]]}');
    const page = service.execute({ version: 2, requestId: "corrupt", operation: { kind: "get_qa_timeline", runId: "run-a", workId: "T001" } });
    const report = page.items.find(item => (item as { kind?: string }).kind === "report") as { correlations: Array<{ label: string }> };
    assert.deepEqual(report.correlations.map(item => item.label), ["unavailable", "unavailable", "unavailable"]);
  } finally { service.close(); f.close(); }
});
