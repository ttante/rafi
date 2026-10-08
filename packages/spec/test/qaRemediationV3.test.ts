import assert from "node:assert/strict";
import test from "node:test";
import { parseBuilderQaRemediationContract, BUILDER_QA_REMEDIATION_START as START, BUILDER_QA_REMEDIATION_END as END } from "../src/qaFailureReport.js";
import { validateBuilderQaRemediationReportV2 } from "../src/validate.js";
const finding = { finding_key: "key", raw_id: "QA-1", disposition: "blocked", changes: ["Partial progress retained"], evidence: "Registry unavailable", verification: [{ check: "install", outcome: "not_run", evidence: "Registry unavailable" }], blocker: { category: "environment", reason: "Registry unavailable", recovery: "Restore registry access", capability: "registry", evidence: "ENOTFOUND" } };
const report = { version: 3, handoff_id: "handoff", summary: "Partial result", findings: [finding], observations: [] };
const envelope = (value: unknown, status: string) => `${START}\n${JSON.stringify(value)}\n${END}\n${status}`;

test("V3 represents structured blockers and partial coverage without changing V2", () => {
  const parsed = parseBuilderQaRemediationContract(envelope(report, 'STEP_STATUS: blocked | reason="Restore registry access"'));
  assert.equal(parsed.valid, true, parsed.errors.join("; "));
  assert.equal(parsed.report?.version, 3);
  assert.equal(validateBuilderQaRemediationReportV2(report).valid, false);
  assert.equal(parseBuilderQaRemediationContract(envelope(report, 'STEP_STATUS: done | summary="done"')).valid, false);
  const { blocker: _blocker, ...withoutBlocker } = finding;
  assert.equal(parseBuilderQaRemediationContract(envelope({ ...report, findings: [withoutBlocker] }, 'STEP_STATUS: blocked | reason="Unavailable"')).valid, false);
  const legacy = { ...report, version: 2, findings: [{ ...withoutBlocker, disposition: "disputed" }] };
  assert.equal(parseBuilderQaRemediationContract(envelope(legacy, 'STEP_STATUS: done | summary="disputed"')).valid, true);
});

test("truthful blocked/questions are outcomes and conflicting, empty, or trailing statuses stay invalid", () => {
  assert.equal(parseBuilderQaRemediationContract('STEP_STATUS: needs_input | question="Which registry?"').valid, true);
  assert.equal(parseBuilderQaRemediationContract('STEP_STATUS: blocked | reason="Registry unavailable"').valid, true);
  for (const text of ['STEP_STATUS: blocked', 'STEP_STATUS: needs_input | question=" "', 'STEP_STATUS: blocked | reason="x"\nSTEP_STATUS: done', 'STEP_STATUS: blocked | reason="x"}', 'STEP_STATUS: needs_input | question="x"\ntrailing']) assert.equal(parseBuilderQaRemediationContract(text).valid, false, text);
  const fixed = { ...report, findings: [{ ...finding, disposition: "fixed", blocker: undefined }] };
  assert.equal(parseBuilderQaRemediationContract(envelope(fixed, 'STEP_STATUS: done').replace(`${END}\n`, `${END}\ntrailing garbage\n`)).valid, false);
});
