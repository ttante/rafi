import { assertBuilderContractCoverage } from "./qaBuilderCoverage.js";
import { resolveEffectiveQaConfiguration } from "./qaEffectiveConfig.js";
import { contractDigest } from "./qaVerificationContract.js";
import { queueGraphMaintenance } from "./graph/boundary.js";
import { actualContractSession, assertContractReceipt } from "./qaContractDelivery.js";
import type { BuilderAdapter } from "./adapters/types.js";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { StepStatus } from "./foreman.js";
import type { TurnResult } from "./adapters/types.js";
import { captureFrozenQaSource, type FrozenQaSourceState } from "./qaSnapshot.js";
import { WorkflowDb } from "./workflowDb.js";
import { WorkflowReader } from "./workflowReader.js";

/** Work responses confirm an assignment; they never select the next ticket. */
export function validateBuildAssignment(ticketId: string, status: StepStatus, responseText = ""): string | undefined {
  // An unmarked response may receive the existing bounded response-only repair.
  // Explicit foreign markers must not be erased by a parser error or correction.
  const named = [...responseText.matchAll(/\bticket="([^"]*)"/g)].map(match => match[1]);
  if (status.kind === "unknown" && !status.ticket && named.every(id => id === ticketId)) return undefined;
  if (status.ticket !== ticketId) {
    return `Builder response named ${status.ticket ?? "no ticket"}, but this turn was assigned to ${ticketId}. Preserved work requires ownership reconciliation before further execution.`;
  }
  if (status.kind === "qa_pass" || status.kind === "qa_fail") return `Builder emitted QA status ${status.kind} for assigned ticket ${ticketId}; independent QA is required.`;
  return undefined;
}

export interface BuildAssignmentCapture {
  operationId: string;
  runId: string;
  ticketId: string;
  worktree: string;
  before: BuildSourceState;
  instruction: string;
  guidanceIds: string[];
}

type BuildSourceState = Pick<FrozenQaSourceState, "digest" | "head" | "contentDigest" | "capturedAt" | "pathInventory" | "stagedDiff" | "unstagedDiff" | "untracked"> & { captureMode: "git" | "filesystem"; omissions?: string[] };

export class BuildAssignmentRejected extends Error {}

export interface BuilderGuidanceFollowup {
  reviewAttemptId: string;
  requirementsDigest: string;
  maximum: number;
  authorizationId?: string;
}

export function assertBuildAssignmentReconciled(projectDir: string, runId: string, worktree = projectDir): void {
  const reader = new WorkflowReader(projectDir);
  try {
    const runs = [...new Set([runId,...reader.buildRuns(true).map(run=>run.runId)])];
    for (const operation of runs.flatMap(id=>reader.operations(id,true))) {
      if (operation.kind !== "build-assignment") continue;
      const result = operation.result as { rejection?: string; sourceError?: string } | undefined;
      if ((result as {reconciliationId?:string}|undefined)?.reconciliationId) continue;
      if(!result?.rejection&&!result?.sourceError&&operation.status!=="in_progress"&&operation.status!=="uncertain")continue;
      const intent = operation.intent as {worktree?: string};
      if(operation.runId !== runId) {
        if(!intent.worktree)continue;
        try {if(realpathSync(intent.worktree)!==realpathSync(worktree))continue;}
        catch {if(resolve(intent.worktree)!==resolve(worktree))continue;}
      }
      if (result?.rejection || result?.sourceError || operation.status === "in_progress" || operation.status === "uncertain") {
        throw new BuildAssignmentRejected(`Build ${runId} requires assignment reconciliation for ${operation.idempotencyKey}: ${result?.rejection ?? result?.sourceError ?? "provider dispatch outcome is unconfirmed"}. Inspect with rafi manager --ask '/qa-conflicts ${runId}'.`);
      }
    }
  } finally { reader.close(); }
}

/** Commit response/source bytes before interpreting any scoped outcome. */
export function beginBuildAssignment(projectDir: string, runId: string, ticketId: string, worktree: string, instruction: string, followup?: BuilderGuidanceFollowup, adapter?: BuilderAdapter): BuildAssignmentCapture {
  assertBuildAssignmentReconciled(projectDir, runId,worktree);
  const operationId = `build-assignment:${runId}:${randomUUID()}`;
  const db = new WorkflowDb(projectDir);
  try {
    const before = captureBuildSource(worktree);
    let guidance = {text: instruction, ids: [] as string[]};
    db.atomic(() => {
      db.ensureRun(runId);
      const admission = db.assertAdmittedWork(runId, ticketId);
      let contractBinding: { digest: string; revision: number; receiptOperationId: string; session: ReturnType<typeof actualContractSession> } | undefined;
      if (db.qaPreparationStore().policy(runId)?.mode === "enforce") {
        const contract = assertContractReceipt(db.qaPreparationStore(), runId, ticketId, admission.requirementsDigest, adapter ? actualContractSession(adapter, worktree, projectDir) : undefined, adapter);
        const session = actualContractSession(adapter!, worktree, projectDir);
        const receipt = db.qaPreparationStore().receipts(contract.contentDigest).find(row => row.sessionId === session.sessionId && row.generation === session.generation && row.workspace === session.workspace && row.compactionSequence === session.compactionSequence)!;
        contractBinding = { digest: contract.contentDigest, revision: contract.revision, receiptOperationId: receipt.operationId, session };
        const qaMake = (db.getRun(runId)?.state as { qa?: { settings?: { make?: "claude" | "codex" } } })?.qa?.settings?.make ?? adapter!.agent;
        const current = resolveEffectiveQaConfiguration(projectDir, { make: qaMake });
        if (contract.inputs.find(input => input.kind === "rules")?.digest !== current.digest || contract.inputs.find(input => input.kind === "checklist")?.digest !== contractDigest("input-checklist", current.checklist)) throw new BuildAssignmentRejected("Canonical QA rules, skills or checklist changed after delivery; reconcile the contract before implementation");
      }
      guidance = db.reserveGuidance(runId, ticketId, "builder", operationId, before.digest, instruction);
      if (followup) {
        if (admission.requirementsDigest !== followup.requirementsDigest) throw new BuildAssignmentRejected("Ticket requirements changed; renewed scope approval is required before the Builder follow-up");
        if (!guidance.ids.length) throw new BuildAssignmentRejected("No eligible Builder guidance remains; no follow-up was dispatched");
        const latest = db.qaReviewAttempts(runId, ticketId).at(-1);
        const head = db.qaTicketHead(runId, ticketId);
        if (latest?.attemptId !== followup.reviewAttemptId || latest.status !== "passed" || head.state !== "passed") throw new BuildAssignmentRejected("Builder follow-up requires the current unfinalized QA pass");
        db.reserveQaRemediation(runId, ticketId, latest.attemptId, operationId, followup.maximum, followup.authorizationId);
        db.invalidateUnconsumedQaPassCertificates(runId, ticketId, "builder-guidance-followup");
        db.transitionQa(runId, ticketId, head.revision, { type: "builder-guidance-followup-intended" });
      }
      const instructionDigest = db.putEvidence("qa", Buffer.from(guidance.text));
      db.planOperation({ runId, idempotencyKey: operationId, kind: "build-assignment", intent: { ticketId, worktree, admissionId: admission.assignmentId, requirementsDigest: admission.requirementsDigest, instructionDigest, ...(contractBinding ? { contractBinding } : {}), before: retainSource(db, before), ...(followup ? { managerFollowup: followup } : {}) } });
      db.recordWorkAssignment(runId,ticketId,operationId,{requirementsDigest:admission.requirementsDigest,worktree,sourceDigest:before.digest,ownerGeneration:db.currentLease()?.generation,instructionDigest});
      db.updateOperation(operationId, "in_progress");
    });
    return { operationId, runId, ticketId, worktree, before, instruction:guidance.text, guidanceIds:guidance.ids };
  } finally { db.close(); }
}

export function finishBuildAssignment(projectDir: string, assignment: BuildAssignmentCapture, result: TurnResult, status: StepStatus): string | undefined {
  let rejection = result.failure?.dispatchState === "not-sent" ? undefined : validateBuildAssignment(assignment.ticketId, status, result.text);
  // Source capture can fail after an external turn. Keep the response even then.
  let after: BuildSourceState | undefined;
  let sourceError: string | undefined;
  try { after = captureBuildSource(assignment.worktree); } catch (error) { sourceError = error instanceof Error ? error.message : String(error); }
  if (result.failure?.dispatchState === "not-sent" && after && after.contentDigest !== assignment.before.contentDigest) rejection = "Provider claimed an unsubmitted turn but product source changed; reconcile the captured source before continuing";
  const db = new WorkflowDb(projectDir);
  try {
    db.atomic(() => {
      if (!rejection && !result.isError && !result.failure && ["done", "plan_complete"].includes(status.kind) && after) {
        try { assertBuilderContractCoverage(db, assignment.runId, assignment.ticketId, assignment.operationId, after.digest); }
        catch (error) { rejection = String(error); }
      }
      const responseDigest = db.putEvidence("qa", Buffer.from(result.rawResponse ?? result.text));
      const cleanedResponseDigest = db.putEvidence("qa", Buffer.from(result.cleanedResponse ?? result.text));
      const providerInstructionDigest = result.providerInstruction ? db.putEvidence("qa", Buffer.from(result.providerInstruction)) : undefined;
      db.updateOperation(assignment.operationId, result.failure?.dispatchState === "unknown" || result.isError && !result.failure?.dispatchState && status.kind === "unknown" ? "uncertain" : "confirmed", { result: { turnId:result.turnId, responseDigest, cleanedResponseDigest, providerInstructionDigest, providerMetadata: result.providerMetadata, dispatchState: result.failure?.dispatchState, status, rejection, sourceError, after: after ? retainSource(db, after) : undefined } });
      const admission = db.assertAdmittedWork(assignment.runId, assignment.ticketId);
      db.qaPreparationStore().metric(assignment.runId, assignment.ticketId, admission.requirementsDigest, `metric:builder-result:${assignment.operationId}`, "phase-observation", { phase: "builder", durationMs: Math.max(0, Date.now() - Date.parse(assignment.before.capturedAt)), costUsd: result.costAuthoritative ? result.costUsd : null, inputTokens: result.inputTokens ?? null, outputTokens: result.outputTokens ?? null });
      db.finishGuidance(assignment.guidanceIds, "builder", {submitted: result.failure?.dispatchState === "not-sent" ? false : result.turnId ? true : undefined, receipt: result.turnId ? {turnId:result.turnId,responseDigest,providerInstructionDigest,postSourceDigest:after?.digest} : undefined, applied: !rejection && status.kind === "done" && assignment.guidanceIds.every(id => result.text.includes(id))});
      if (rejection || sourceError) {
        const run = db.getRun(assignment.runId)!;
        db.transition(assignment.runId, { checkpoint: "build-assignment-rejected", state: { ...run.state, assignmentConflict: { operationId: assignment.operationId, ticketId: assignment.ticketId, worktree: assignment.worktree, responseDigest, rejection, sourceError } }, event: "build_assignment_rejected", payload: { operationId: assignment.operationId, ticketId: assignment.ticketId, returnedTicketId: status.ticket, responseDigest, rejection, sourceError } });
      }
    });
  } finally { db.close(); }
  if(!rejection&&!sourceError&&!result.isError&&status.kind==="done"&&after){try{queueGraphMaintenance(projectDir,assignment.worktree,assignment.operationId,result.text,after.contentDigest!==assignment.before.contentDigest);}catch(error){console.error(`Graph maintenance deferred: ${String(error)}`);}}
  return rejection ?? (sourceError ? `Builder source evidence is unavailable: ${sourceError}. Reconcile before continuing.` : undefined);
}

function retainSource(db: WorkflowDb, source: BuildSourceState): Record<string, unknown> {
  const staged = retainDiff(db, source.stagedDiff);
  const unstaged = retainDiff(db, source.unstagedDiff);
  return { digest: source.digest, head: source.head, captureMode: source.captureMode, omissions: source.omissions, contentDigest: source.contentDigest, capturedAt: source.capturedAt, pathInventory: source.pathInventory,
    stagedDiffDigest: staged.digest, stagedDiffChunks: staged.chunks, stagedDiffBytes: source.stagedDiff.length,
    unstagedDiffDigest: unstaged.digest, unstagedDiffChunks: unstaged.chunks, unstagedDiffBytes: source.unstagedDiff.length,
    untracked: source.untracked.map(file => { const evidence = retainDiff(db, file.bytes); return { path: file.path, mode: file.mode, kind: file.kind, digest: file.digest, evidenceDigest: evidence.digest, evidenceChunks: evidence.chunks, byteLength: file.bytes.length }; }) };
}

/** Preserve large product files without changing the shared per-item evidence limits. */
function retainDiff(db: WorkflowDb, bytes: Buffer): { digest?: string; chunks?: string[] } {
  if (bytes.length <= 16 * 1024 * 1024) return { digest: db.putEvidence("diff", bytes) };
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8 * 1024 * 1024) chunks.push(db.putEvidence("diff", bytes.subarray(offset, offset + 8 * 1024 * 1024)));
  return { chunks };
}

export function captureBuildSource(worktree: string): BuildSourceState {
  const head = spawnSync("git", ["-C", worktree, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (head.status === 0) return { ...captureFrozenQaSource(worktree), captureMode: "git" };
  if ((head.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT" && !/not a git repository|Needed a single revision|unknown revision/.test(head.stderr ?? "")) throw head.error ?? new Error(`Git source identity is unavailable: ${head.stderr}`);
  const capture = (): BuildSourceState => {
    const root = resolve(worktree);
    const untracked: FrozenQaSourceState["untracked"] = [];
    const ignored = new Set([".git", ".rafi", ".foreman", "node_modules"]);
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (ignored.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() || entry.isSymbolicLink()) {
          const kind = entry.isSymbolicLink() ? "symlink" : "file";
          const bytes = kind === "symlink" ? Buffer.from(readlinkSync(path)) : readFileSync(path);
          untracked.push({ path: relative(root, path).replace(/\\/g, "/"), kind, bytes, mode: lstatSync(path).mode, digest: createHash("sha256").update(bytes).digest("hex") });
        } else throw new Error(`Unsupported source path type: ${path}`);
      }
    };
    visit(root);
    const contentDigest = createHash("sha256").update(JSON.stringify(untracked.map(({ bytes: _, ...identity }) => identity))).digest("hex");
    return { digest: contentDigest, head: "unavailable", captureMode: "filesystem", omissions: ["Git baseline/diff unavailable: project is not a repository or has no first commit"], contentDigest, capturedAt: new Date().toISOString(),
      pathInventory: untracked.map(file => ({ path: file.path, staged: [], unstaged: [], untracked: { kind: file.kind, mode: file.mode, digest: file.digest } })), untracked, stagedDiff: Buffer.alloc(0), unstagedDiff: Buffer.alloc(0) };
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = capture(); const after = capture();
    if (before.digest === after.digest) return after;
  }
  throw new Error("Product source changed during assignment evidence capture; retry at a stable boundary");
}
