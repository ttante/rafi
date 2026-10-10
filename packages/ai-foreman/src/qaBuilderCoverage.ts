import { dispatchWithGraphAccess, withGraphSessionAccess } from "./graph/session.js";
import type { BuilderAdapter, TurnResult } from "./adapters/types.js";
import { WorkflowDb } from "./workflowDb.js";
import { actualContractSession, assertContractReceipt } from "./qaContractDelivery.js";
import { captureBuildSource } from "./buildAssignment.js";
import { COVERAGE_INSTRUCTIONS, parseContractCoverage, validateContractCoverage } from "./qaContractCoverage.js";
import { contractDigest } from "./qaVerificationContract.js";
import { OperationDeadline } from "./util/deadline.js";

/** Claims are collected after source capture so the provider can name the actual completed source. */
export async function collectBuilderContractCoverage(projectDir: string, runId: string, workId: string, workspace: string, adapter: BuilderAdapter, operationId: string, instruction: string, implementation: TurnResult): Promise<void> {
  return withGraphSessionAccess(projectDir, adapter, () => collectBuilderContractCoverageOwned(projectDir, runId, workId, workspace, adapter, operationId, instruction, implementation));
}
async function collectBuilderContractCoverageOwned(projectDir: string, runId: string, workId: string, workspace: string, adapter: BuilderAdapter, operationId: string, instruction: string, implementation: TurnResult): Promise<void> {
  const db = new WorkflowDb(projectDir);
  try {
    const store = db.qaPreparationStore();
    if (store.policy(runId)?.mode !== "enforce") return;
    const admission = db.assertAdmittedWork(runId, workId);
    const session = actualContractSession(adapter, workspace, projectDir);
    const contract = assertContractReceipt(store, runId, workId, admission.requirementsDigest, session, adapter);
    const source = captureBuildSource(workspace);
    const binding = { phase: "builder" as const, sourceDigest: source.digest, inputBasisDigest: contractDigest("builder-input-basis", { operationId, instruction, contractDigest: contract.contentDigest }), attemptId: operationId, sessionId: session.sessionId };
    const eventId = `builder-coverage:${operationId}`;
    const existing = db.operation(eventId);
    if (existing) {
      if (existing.status !== "confirmed") throw new Error("Uncertain Builder coverage dispatch must be reconciled without redispatch");
      const retained = existing.result as { coverageDigest: string };
      const errors = validateContractCoverage(contract, store.artifact(retained.coverageDigest, "builder-coverage"), binding, false);
      if (errors.length) throw new Error(errors.join("; "));
      return;
    }
    // Preserve the implementation response before a failed acknowledgment or a crash.
    const implementationDigest = db.putEvidence("qa", implementation.rawResponse ?? implementation.text);
    db.planOperation({ runId, idempotencyKey: eventId, kind: "builder-coverage", intent: { workId, contractDigest: contract.contentDigest, binding, implementationDigest, session } });
    db.updateOperation(eventId, "in_progress");
    try {
      const prompt = `Response-only evidence collection for completed implementation ${operationId}. Do not run tools, modify files, repeat work, or invent verification. Record failed, blocked or not-run truthfully. The implementation response is retained as ${implementationDigest}.\n${COVERAGE_INSTRUCTIONS}\nExact coverage binding: ${JSON.stringify({ version: 1, runId, workId, revision: contract.revision, contractDigest: contract.contentDigest, ...binding })}\nAll checks: ${JSON.stringify(contract.checks)}`;
      const response = await new OperationDeadline("Builder coverage acknowledgment", 120_000).run(() => dispatchWithGraphAccess(projectDir, adapter, prompt, { purpose: "response-repair", responseOnly: true }, (text, policy) => adapter.sendTurn(text, policy)), () => { void adapter.close(); });
      const responseDigest = db.putEvidence("qa", response.rawResponse ?? response.text);
      db.updateOperation(eventId, "uncertain", { result: { responseDigest } });
      if (response.isError || response.failure) throw new Error("Builder coverage provider failed; retained response requires reconciliation");
      if (JSON.stringify(actualContractSession(adapter, workspace, projectDir)) !== JSON.stringify(session) || captureBuildSource(workspace).digest !== source.digest) throw new Error("Builder coverage changed session or product source");
      const coverage = parseContractCoverage(response.text);
      const errors = validateContractCoverage(contract, coverage, binding, false);
      if (errors.length) throw new Error(`Builder coverage invalid: ${errors.join("; ")}`);
      const coverageDigest = store.putArtifact("builder-coverage", coverage);
      db.updateOperation(eventId, "confirmed", { result: { responseDigest, coverageDigest, binding, implementationDigest } });
    } catch (error) {
      throw new Error(`Builder evidence collection blocked: ${String(error)}`);
    }
  } finally { db.close(); }
}

export function assertBuilderContractCoverage(db: WorkflowDb, runId: string, workId: string, operationId: string, sourceDigest: string): void {
  const store = db.qaPreparationStore();
  if (store.policy(runId)?.mode !== "enforce") return;
  const admission = db.assertAdmittedWork(runId, workId), head = store.head(runId, workId, admission.requirementsDigest);
  if (head.state !== "ready" || !head.digest) throw new Error("Completion requires the ready contract");
  const operation = db.operation(`builder-coverage:${operationId}`);
  if (operation?.status !== "confirmed") throw new Error("Completion requires retained, source-bound Builder check coverage");
  const result = operation.result as { coverageDigest: string; binding: Parameters<typeof validateContractCoverage>[2] };
  if (result.binding.sourceDigest !== sourceDigest || result.binding.attemptId !== operationId) throw new Error("Builder completion coverage is stale");
  const errors = validateContractCoverage(store.contract(head.digest), store.artifact(result.coverageDigest, "builder-coverage"), result.binding, false);
  if (errors.length) throw new Error(errors.join("; "));
}
