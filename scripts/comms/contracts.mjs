/** Executable contract design examples. Not exported by any production package. */
import { z } from "zod";

const text = z.string().min(1).max(4000);
const refs = z.array(z.string().min(1).max(256)).max(100);
const blocked = z.strictObject({ kind: z.literal("blocked"), reason: text,
  nextAction: text, evidenceIds: refs });
const continuity = z.strictObject({ summary: text, uncertainties: z.array(text).max(20) });
const envelope = (operation, result) => z.strictObject({ version: z.literal(1),
  operation: z.literal(operation), result, continuity });
export const contracts = {
  "work-report": envelope("work-report", z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("completed"), summary: text,
      change: z.enum(["modified", "already-satisfied"]), evidenceIds: refs }), blocked,
  ])),
  "qa-verdict": envelope("qa-verdict", z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("passed"), summary: text, evidenceIds: refs }),
    z.strictObject({ kind: z.literal("failed"), summary: text, evidenceIds: refs,
      findings: z.array(z.strictObject({ requirementId: text, problem: text,
        evidenceIds: refs, verification: text })).min(1).max(50) }), blocked,
  ])),
  "handoff": envelope("handoff", z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("requested"), reason: text,
      remainingWork: z.array(text).min(1).max(50), evidenceIds: refs }),
    z.strictObject({ kind: z.literal("received"), resourceIds: refs, uncertainties: z.array(text).max(20) }), blocked,
  ])),
};
export function projectCodexSchema(value) {
  if (Array.isArray(value)) return value.map(projectCodexSchema);
  if (!value || typeof value !== "object") return value;
  const output = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, projectCodexSchema(child)]));
  if (output.oneOf) {
    // oneOf -> anyOf is equivalent ONLY when branches cannot overlap. Require
    // a mandatory unique literal discriminator on every strict object branch.
    const kinds = output.oneOf.map(branch => branch.properties?.kind?.const);
    if (output.anyOf || kinds.some(kind => typeof kind !== "string") || new Set(kinds).size !== kinds.length ||
      output.oneOf.some(branch => branch.type !== "object" || branch.additionalProperties !== false || !branch.required?.includes("kind"))) {
      throw new Error("Cannot project overlapping/non-discriminated oneOf without changing contract meaning");
    }
    output.anyOf = output.oneOf; delete output.oneOf;
  }
  return output;
}
export function wireSchema(operation, provider = "claude") {
  const schema = z.toJSONSchema(contracts[operation], { target: "draft-7", io: "input" });
  if (provider === "claude") return schema;
  if (provider === "codex") return projectCodexSchema(schema);
  throw new Error("No tested schema profile for this provider");
}
export const requestSchema = z.strictObject({ operation: z.enum(["work-report", "qa-verdict", "handoff"]),
  schemaVersion: z.literal(1), actionId: text, dispatchId: text, sessionId: text,
  generation: z.number().int().nonnegative(), sourceDigest: text, contractDigest: text,
  allowedOutcomes: refs.min(1), allowedEvidenceIds: refs, requiredCheckIds: refs,
  requirementIds: refs, requiredResourceIds: refs });

// Host ownership does not make malformed/missing facts safe. Validate the
// observation before policy comparisons, and reject ambiguous ID lookups.
const uniqueBy = (rows, key) => new Set(rows.map(row => row[key])).size === rows.length;
const observationSchema = z.object({
  actionId: text, dispatchId: text, sessionId: text, generation: z.number().int().nonnegative(),
  sourceDigest: text, contractDigest: text, terminal: z.literal("completed"),
  authorized: z.boolean(), acceptedDispatchIds: refs,
  evidence: z.array(z.strictObject({ id: text, available: z.boolean(), sourceDigest: text }))
    .refine(rows => uniqueBy(rows, "id")),
  checks: z.array(z.strictObject({ id: text, outcome: z.enum(["passed", "failed", "blocked"]),
    sourceDigest: text, contractDigest: text, evidenceIds: refs })).refine(rows => uniqueBy(rows, "id")),
  independentReview: z.boolean(), unresolvedBlockingFindings: z.number().int().nonnegative(),
  handoffResourcesValidated: z.boolean(), successorLeaseEligible: z.boolean(),
});

/** Pure policy rehearsal over HOST-OBSERVED facts; deliberately no I/O or durable transitions.
 * Production must acquire these facts under the existing transaction/fencing rules.
 */
export function decide(request, observation, candidate) {
  const reject = reason => ({ accepted: false, reason, next: "reconcile" });
  if (!request || !Object.hasOwn(contracts, request.operation)) return reject("unsupported-operation");
  if (request.schemaVersion !== 1) return reject("unsupported-version");
  if (!requestSchema.safeParse(request).success) return reject("invalid-host-request");
  if (observation?.terminal !== "completed") return reject("execution-not-completed");
  for (const key of ["actionId", "dispatchId", "sessionId", "generation", "sourceDigest", "contractDigest"]) {
    if (observation[key] !== request[key]) return reject(`mismatched-${key}`);
  }
  if (observation.authorized !== true) return reject("unauthorized");
  if (!observationSchema.safeParse(observation).success) return reject("invalid-host-observation");
  if (observation.acceptedDispatchIds.includes(request.dispatchId)) return { accepted: false, reason: "duplicate", next: "return-retained-decision" };
  const parsed = contracts[request.operation].safeParse(candidate);
  if (!parsed.success) return reject("invalid-contract");
  const result = parsed.data.result;
  if (!request.allowedOutcomes.includes(result.kind)) return reject("outcome-not-allowed");
  const evidenceIds = [...(result.evidenceIds ?? []), ...(result.findings ?? []).flatMap(f => f.evidenceIds)];
  if (evidenceIds.some(id => !request.allowedEvidenceIds.includes(id))) return reject("unknown-evidence");
  if (evidenceIds.some(id => !observation.evidence.some(e => e.id === id && e.available && e.sourceDigest === request.sourceDigest))) return reject("unavailable-or-stale-evidence");
  const accept = next => ({ accepted: true, reason: result.kind, next });
  if (result.kind === "blocked") return accept("record-blocker");
  if (result.kind === "requested") return accept("stage-handoff");
  if (result.kind === "received") {
    if (new Set(result.resourceIds).size !== result.resourceIds.length ||
      result.resourceIds.length !== request.requiredResourceIds.length ||
      request.requiredResourceIds.some(id => !result.resourceIds.includes(id))) return reject("resource-set-mismatch");
    if (observation.handoffResourcesValidated !== true || observation.successorLeaseEligible !== true ||
      result.uncertainties.length || parsed.data.continuity.uncertainties.length) return reject("handoff-not-ready");
    return accept("eligible-for-atomic-lease-transfer");
  }
  if (result.kind === "failed") {
    if (observation.independentReview !== true) return reject("qa-not-ready");
    if (result.findings.some(f => !request.requirementIds.includes(f.requirementId) || !f.evidenceIds.length)) return reject("unsupported-finding");
    return accept("record-findings");
  }
  if (!request.requiredCheckIds.length) return reject("missing-verification-policy");
  for (const id of request.requiredCheckIds) {
    const check = observation.checks.find(check => check.id === id);
    if (!check || check.outcome !== "passed" || check.sourceDigest !== request.sourceDigest ||
      check.contractDigest !== request.contractDigest || !check.evidenceIds.length ||
      check.evidenceIds.some(id => !evidenceIds.includes(id))) return reject("verification-incomplete");
  }
  if (result.kind === "completed") return accept("independent-qa");
  if (observation.independentReview !== true || observation.unresolvedBlockingFindings !== 0 ||
    parsed.data.continuity.uncertainties.length) return reject("qa-not-ready");
  return accept("eligible-for-atomic-certification");
}
