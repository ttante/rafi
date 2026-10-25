import assert from "node:assert/strict";
import test from "node:test";
import { remediationOutput } from "../src/qaOutputContracts.js";
import { validateBuilderQaRemediationReportV2, validateBuilderQaRemediationReport } from "../src/validate.js";
const finding = { finding_key: "key", raw_id: "QA-1", disposition: "blocked", changes: ["Partial progress retained"], evidence: "Registry unavailable", verification: [{ check: "install", outcome: "not_run", evidence: "Registry unavailable" }], blocker: { category: "environment", reason: "Registry unavailable", recovery: "Restore registry access", capability: "registry", evidence: "ENOTFOUND" } };
const report = { version: 3, handoff_id: "handoff", summary: "Partial result", findings: [finding], observations: [] };

test("native V3 represents structured blockers without changing V2 validation", () => {
  assert.equal(validateBuilderQaRemediationReport(report).valid, true);
  assert.equal(validateBuilderQaRemediationReportV2(report).valid, false);
  assert.equal(validateBuilderQaRemediationReport({ ...report, findings: [{ ...finding, blocker: { ...finding.blocker, category: "unregistered" } }] }).valid, false);
});

test("native remediation rejects literal marker conversions", () => {
  for (const text of [
    'STEP_STATUS: needs_input | question="Which registry?"',
    'STEP_STATUS: blocked | reason="Registry unavailable"',
    `RAFI_BUILDER_QA_REMEDIATION_START\n${JSON.stringify(report)}\nRAFI_BUILDER_QA_REMEDIATION_END\nSTEP_STATUS: done`,
    `\`\`\`json\n${JSON.stringify(report)}\n\`\`\``,
  ]) assert.equal(remediationOutput.schema.safeParse(text).success, false, text);
});
