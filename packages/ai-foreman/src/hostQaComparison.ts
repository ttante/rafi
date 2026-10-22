import { z } from "zod";
import type { QaContractCoverageV1, QaVerificationContractV1 } from "rafi-spec";
import type { TicketDef } from "./tickets/ticketSchema.js";
import { captureBuildSource } from "./buildAssignment.js";
import type { WorkflowDb } from "./workflowDb.js";
import { contractDigest } from "./qaVerificationContract.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(1024);

export const hostQaComparisonV1Schema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  ticketId: z.string().min(1),
  assignmentId: z.string().min(1),
  contractDigest: digest,
  contractRevision: z.number().int().positive(),
  reviewAttemptId: z.string().min(1),
  reviewBasisDigest: digest,
  baselineSourceDigest: digest,
  finalSourceDigest: digest,
  scopeBasisDigest: digest,
  status: z.enum(["passed", "failed", "blocked"]),
  changedPaths: z.array(path).max(256),
  unauthorizedPaths: z.array(path).max(256),
  deletedPaths: z.array(path).max(256),
  protectedPaths: z.array(path).max(256),
  reason: z.string().max(2048),
  comparedAt: z.string().datetime(),
});

export type HostQaComparisonV1 = z.infer<typeof hostQaComparisonV1Schema>;

type InventoryPath = {
  path: string;
  headObject?: string;
  indexObject?: string;
  worktreeObject?: string;
  untracked?: { kind: "file" | "symlink"; mode: number; digest: string };
};

type RetainedAssignment = {
  idempotencyKey: string;
  intent: { ticketId?: string; before?: { digest?: string; pathInventory?: InventoryPath[] } };
  result?: { after?: { digest?: string; pathInventory?: InventoryPath[] } };
};

function identity(item: InventoryPath | undefined): string {
  if (!item) return "missing";
  return JSON.stringify({
    headObject: item.headObject,
    indexObject: item.indexObject,
    worktreeObject: item.worktreeObject,
    untracked: item.untracked,
  });
}

function matchesScope(candidate: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized.endsWith("/**")) return candidate === normalized.slice(0, -3) || candidate.startsWith(normalized.slice(0, -2));
    if (normalized.includes("*")) {
      const expression = new RegExp(`^${normalized.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      return expression.test(candidate);
    }
    return candidate === normalized;
  });
}

function isHostQaCheck(check: QaVerificationContractV1["checks"][number]): boolean {
    const text = `${check.expectedBehavior} ${check.expectedEvidence.join(" ")} ${check.applicability.requiredEvidence.join(" ")}`;
    const hostScopeEvidence = check.applicability.requiredEvidence.some(evidence => /host[- ]owned.*scope comparison/i.test(evidence));
    const scopeSemantics = /scope/i.test(text) && /comparison/i.test(text) && /baseline|protected|approved scope|product changes/i.test(text);
    const changedProductPaths = /changed product paths/i.test(text) && /host[- ]retained|baseline|bookkeeping|evidence exclusions/i.test(text);
    return !/documentation/i.test(text)
      && (hostScopeEvidence || changedProductPaths || (check.applicability.decisionOwner === "host" && (/Rafi compares the final product paths/i.test(check.expectedBehavior) || scopeSemantics)));
}

export function findHostQaCheck(contract: QaVerificationContractV1): QaVerificationContractV1["checks"][number] | undefined {
  return contract.checks.find(isHostQaCheck);
}

function findHostQaChecks(contract: QaVerificationContractV1): QaVerificationContractV1["checks"] {
  return contract.checks.filter(isHostQaCheck);
}

function findHostDocumentationCheck(contract: QaVerificationContractV1): QaVerificationContractV1["checks"][number] | undefined {
  return contract.checks.find(check => check.applicability.decisionOwner === "host"
    && /documentation/i.test(check.expectedBehavior)
    && /documentation/i.test(check.expectedEvidence.join(" ")));
}

function findAssignment(db: Pick<WorkflowDb, "operations">, runId: string, ticketId: string, baselineDigest: string): RetainedAssignment | undefined {
  const operations = db.operations(runId) as unknown as RetainedAssignment[];
  return operations
    .filter(operation => operation.intent?.ticketId === ticketId && operation.intent?.before?.digest === baselineDigest
      && Array.isArray(operation.intent.before.pathInventory) && Array.isArray(operation.result?.after?.pathInventory))
    .at(-1);
}

function baselineDigest(contract: QaVerificationContractV1): string | undefined {
  return contract.inputs.find(input => input.id === "preimplementation-source")?.digest;
}

function resultEvidence(resultDigest: string, projectDir: string, sourceDigest: string, status: HostQaComparisonV1["status"], reason: string) {
  return {
    procedure: "Rafi host-owned comparison of the retained preimplementation inventory and final Builder source",
    cwd: projectDir,
    runtime: "Rafi host",
    sourceDigest,
    reference: `host-qa-comparison:${resultDigest}`,
    ...(status === "passed" ? {} : { limitation: reason }),
  };
}

/**
 * Performs the private host comparison and returns the immutable artifact plus
 * the coverage row replacement. Provider output is never used to decide scope.
 */
export function createHostQaComparison(input: {
  db: Pick<WorkflowDb, "operations" | "qaPreparationStore">;
  projectDir: string;
  worktree: string;
  runId: string;
  ticket: TicketDef;
  contract: QaVerificationContractV1;
  reviewAttemptId: string;
  reviewBasisDigest: string;
}): { result: HostQaComparisonV1; resultDigest: string; checkId?: string } {
  const check = findHostQaCheck(input.contract);
  if (!check) throw new Error("Host QA comparison contract check is missing");
  const expectedBaseline = baselineDigest(input.contract);
  if (!expectedBaseline) throw new Error("Host QA comparison lacks the admitted preimplementation baseline");
  const assignment = findAssignment(input.db, input.runId, input.ticket.id, expectedBaseline);
  const finalFirst = captureBuildSource(input.worktree);
  const finalSecond = captureBuildSource(input.worktree);
  if (finalFirst.digest !== finalSecond.digest) throw new Error("Host QA comparison source changed during final capture");
  const final = finalSecond;
  const before = assignment?.intent.before;
  const assignmentId = assignment?.idempotencyKey ?? "missing-assignment";
  const beforePaths = new Map((before?.pathInventory ?? []).map(item => [item.path, item]));
  const afterPaths = new Map(final.pathInventory.map(item => [item.path, item as InventoryPath]));
  const allPaths = [...new Set([...beforePaths.keys(), ...afterPaths.keys()])].sort();
  const changedPaths = allPaths.filter(item => identity(beforePaths.get(item)) !== identity(afterPaths.get(item)));
  const deletedPaths = [...beforePaths.keys()].filter(item => !afterPaths.has(item)).sort();
  const protectedPaths = changedPaths.filter(item => item === ".git" || item.startsWith(".git/") || item === ".rafi" || item.startsWith(".rafi/") || item === ".foreman" || item.startsWith(".foreman/")).sort();
  const scopePatterns = input.ticket.likely_files.map(item => item.replaceAll("\\", "/"));
  const unauthorizedPaths = scopePatterns.length ? changedPaths.filter(item => !matchesScope(item, scopePatterns)) : changedPaths;
  const scopeBasisDigest = contractDigest("host-qa-scope-basis", { ticketId: input.ticket.id, ticket: input.ticket, contractDigest: input.contract.contentDigest, assignmentId });
  const missingBaseline = !assignment || !before || before.digest !== expectedBaseline;
  const status: HostQaComparisonV1["status"] = missingBaseline || protectedPaths.length || deletedPaths.length || unauthorizedPaths.length ? (missingBaseline ? "blocked" : "failed") : "passed";
  const reason = missingBaseline
    ? "The admitted Builder assignment baseline was not retained or does not match the contract baseline."
    : protectedPaths.length
      ? `Protected paths changed: ${protectedPaths.slice(0, 8).join(", ")}`
      : deletedPaths.length
        ? `Product paths were deleted: ${deletedPaths.slice(0, 8).join(", ")}`
        : unauthorizedPaths.length
          ? `Changed paths are outside the host-resolved ticket scope: ${unauthorizedPaths.slice(0, 8).join(", ")}`
          : "Host-observed product paths match the retained baseline and host-resolved ticket scope.";
  const result = hostQaComparisonV1Schema.parse({ version: 1, runId: input.runId, ticketId: input.ticket.id, assignmentId, contractDigest: input.contract.contentDigest, contractRevision: input.contract.revision, reviewAttemptId: input.reviewAttemptId, reviewBasisDigest: input.reviewBasisDigest, baselineSourceDigest: expectedBaseline, finalSourceDigest: final.digest, scopeBasisDigest, status, changedPaths, unauthorizedPaths, deletedPaths, protectedPaths, reason, comparedAt: new Date().toISOString() });
  const store = input.db.qaPreparationStore();
  const existing = store.artifacts("host-qa-comparison").find(item => {
    const candidate = hostQaComparisonV1Schema.safeParse(item.value);
    if (!candidate.success) return false;
    const prior = candidate.data;
    return prior.runId === result.runId && prior.ticketId === result.ticketId && prior.assignmentId === result.assignmentId
      && prior.contractDigest === result.contractDigest && prior.contractRevision === result.contractRevision
      && prior.reviewAttemptId === result.reviewAttemptId && prior.reviewBasisDigest === result.reviewBasisDigest
      && prior.baselineSourceDigest === result.baselineSourceDigest && prior.finalSourceDigest === result.finalSourceDigest
      && prior.scopeBasisDigest === result.scopeBasisDigest && prior.status === result.status
      && JSON.stringify(prior.changedPaths) === JSON.stringify(result.changedPaths)
      && JSON.stringify(prior.unauthorizedPaths) === JSON.stringify(result.unauthorizedPaths)
      && JSON.stringify(prior.deletedPaths) === JSON.stringify(result.deletedPaths)
      && JSON.stringify(prior.protectedPaths) === JSON.stringify(result.protectedPaths)
      && prior.reason === result.reason;
  });
  const resultDigest = existing?.digest ?? store.putArtifact("host-qa-comparison", result);
  return { result: existing ? hostQaComparisonV1Schema.parse(existing.value) : result, resultDigest, checkId: check.id };
}

export function applyHostQaComparison(coverage: QaContractCoverageV1, contract: QaVerificationContractV1, result: HostQaComparisonV1, resultDigest: string, projectDir: string): QaContractCoverageV1 {
  const parsed = hostQaComparisonV1Schema.parse(result);
  if (parsed.contractDigest !== contract.contentDigest || parsed.contractRevision !== contract.revision || parsed.runId !== contract.runId || parsed.ticketId !== contract.workId || parsed.finalSourceDigest !== coverage.sourceDigest || parsed.reviewAttemptId !== coverage.attemptId || parsed.reviewBasisDigest !== coverage.inputBasisDigest) throw new Error("Host QA comparison is not bound to the current contract, review, or source");
  const checks = findHostQaChecks(contract);
  if (!checks.length) throw new Error("Host QA comparison contract check is missing");
  const copy = structuredClone(coverage);
  for (const check of checks) {
    const row = {
      checkId: check.id,
      applicability: "applicable" as const,
      predicateEvidence: ["Rafi host-owned scope comparison executed against the retained baseline."],
      outcome: parsed.status === "passed" ? "passed" as const : parsed.status === "failed" ? "failed" as const : "blocked" as const,
      evidence: [resultEvidence(resultDigest, projectDir, parsed.finalSourceDigest, parsed.status, parsed.reason)],
    };
    const index = copy.checks.findIndex(item => item.checkId === check.id);
    if (index < 0) copy.checks.push(row); else copy.checks[index] = row;
  }
  const documentationCheck = findHostDocumentationCheck(contract);
  if (documentationCheck && contract.documentation?.required === false) {
    const documentationRow = {
      checkId: documentationCheck.id,
      applicability: "applicable" as const,
      predicateEvidence: ["The admitted contract explicitly sets documentation.required to false."],
      outcome: "passed" as const,
      evidence: [{
        procedure: "Rafi host-owned evaluation of the admitted documentation policy",
        cwd: projectDir,
        runtime: "Rafi host",
        sourceDigest: parsed.finalSourceDigest,
        reference: `host-qa-documentation:${contract.contentDigest}`,
      }],
    };
    const documentationIndex = copy.checks.findIndex(item => item.checkId === documentationCheck.id);
    if (documentationIndex < 0) copy.checks.push(documentationRow); else copy.checks[documentationIndex] = documentationRow;
  }
  return copy;
}

export function hostComparisonDigestFromCoverage(coverage: QaContractCoverageV1, checkId: string): string | undefined {
  const reference = coverage.checks.find(row => row.checkId === checkId)?.evidence.find(item => item.reference.startsWith("host-qa-comparison:"))?.reference;
  const value = reference?.slice("host-qa-comparison:".length);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
