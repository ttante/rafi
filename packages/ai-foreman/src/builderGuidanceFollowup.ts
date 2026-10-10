import { collectBuilderContractCoverage } from "./qaBuilderCoverage.js";
import { maintainGraphTask } from "./graph/boundary.js";
import { ensureBuilderContract } from "./qaBuildGate.js";
import type { BuilderAdapter } from "./adapters/types.js";
import {graphContext,sendGraphTurn} from "./graph/turn.js";
import { beginBuildAssignment, finishBuildAssignment, type BuilderGuidanceFollowup } from "./buildAssignment.js";
import { parseStepStatus } from "./foreman.js";
import type { QaFixResult } from "./qaReview.js";

/** One journaled mutation shared by current-branch and isolated-worktree resume. */
export async function deliverBuilderGuidanceFollowup(
  scope: { projectDir: string; runId: string; ticketId: string; worktree: string },
  instruction: string,
  followup: BuilderGuidanceFollowup,
  host: {
    prepare(instruction: string): Promise<BuilderAdapter>;
    validateRequirements(): void;
    recordSession?(adapter: BuilderAdapter): void;
    completed?(operationId: string, adapter: BuilderAdapter): Promise<void>;
  },
): Promise<QaFixResult> {
  try {
    const adapter = await host.prepare(instruction);
    await adapter.prepareSession?.();
    host.validateRequirements();
    host.recordSession?.(adapter);
    instruction += "\n" + await ensureBuilderContract(scope.projectDir, scope.runId, scope.ticketId, scope.worktree, adapter);
    const assignment = beginBuildAssignment(scope.projectDir, scope.runId, scope.ticketId, scope.worktree, instruction, followup, adapter);
    // The handback policy prevents provider wrappers from retrying this mutation.
    const result = await sendGraphTurn(adapter,assignment.instruction,graphContext(scope.projectDir,scope.worktree,"manager-guidance",assignment.instruction,{logicalTaskId:assignment.operationId,operationId:assignment.operationId,runId:scope.runId,workId:scope.ticketId}),{handback:true,logicalActionId:assignment.operationId});
    const status = parseStepStatus(result.text);
    if (!result.isError && !result.failure && status.kind === "done") await collectBuilderContractCoverage(scope.projectDir, scope.runId, scope.ticketId, scope.worktree, adapter, assignment.operationId, assignment.instruction, result);
    const rejection = finishBuildAssignment(scope.projectDir, assignment, result, status);
    if(!rejection&&!result.isError&&status.kind==="done")await maintainGraphTask(scope.projectDir,scope.worktree,assignment.operationId,adapter).catch(()=>undefined);
    await host.completed?.(assignment.operationId, adapter);
    if (rejection || result.isError || result.failure || status.kind !== "done" || !result.turnId) return { ok: false, detail: rejection ?? result.failure?.diagnostics ?? `Builder follow-up stopped with ${status.kind}; reconcile its result before continuing`, response: result.text };
    return { ok: true, response: result.text, summary: status.summary ?? "Builder applied waiting guidance", providerTurnId: result.turnId };
  } catch (error) {
    // A thrown submission leaves the assignment in progress. The existing
    // assignment fence prevents another Builder turn without reconciliation.
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
