import type { EquivalentAuthorityResolver } from "./qaAuthorizedDisposition.js";
import { Ajv } from "ajv";
import { qaContractCandidateV1Schema, qaSemanticAssessmentV1Schema, qaChallengeReceiptV1Schema } from "rafi-spec";
const contractAjv = new Ajv({ allErrors: true });
const candidateSchema = contractAjv.compile(qaContractCandidateV1Schema);
const assessmentSchema = contractAjv.compile(qaSemanticAssessmentV1Schema);
const challengeSchema = contractAjv.compile(qaChallengeReceiptV1Schema);
function schemaIssues(errors: typeof candidateSchema.errors): string[] {
  return (errors ?? []).map(error => `${error.instancePath || "/"} ${error.message}${error.keyword === "additionalProperties" ? `: ${String(error.params.additionalProperty)}` : error.keyword === "required" ? `: ${String(error.params.missingProperty)}` : ""}`);
}
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { QaContractCandidateV1, QaVerificationContractV1, QaSemanticAssessmentV1, QaChallengeReceiptV1, ContractInputRef, RequirementRef } from "rafi-spec";
import { canonicalJson } from "./qaProtocolV2.js";
import { depthObligations, validateDepthDecision } from "./qaPreparationPolicy.js";
import type { TicketDef } from "./tickets/ticketSchema.js";

export function canonicalContractJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Contract artifacts must have a JSON representation");
  return canonicalJson(JSON.parse(serialized));
}
export function contractDigest(domain: string, value: unknown): string { return createHash("sha256").update(`rafi:${domain}:v1\n`).update(canonicalContractJson(value)).digest("hex"); }
export function candidatePayload(contract: QaContractCandidateV1 | QaVerificationContractV1): QaContractCandidateV1 {
  const { contentDigest: _content, draftPayloadDigest: _draft, semanticAssessmentDigest: _semantic, challengeReceiptDigest: _challenge, ...payload } = contract as QaVerificationContractV1;
  return payload;
}
export function draftDigest(candidate: QaContractCandidateV1): string { return contractDigest("qa-contract-draft", candidatePayload(candidate)); }
/** Allocate identities from meaning, replacing proposed agent IDs throughout the draft. */
export function allocateStableCheckIds(candidate: QaContractCandidateV1): QaContractCandidateV1 {
  const draft = structuredClone(candidate), mapping = new Map<string, string>(), counts = new Map<string, number>();
  const proposed = new Map(draft.checks.map(check => [check.id, check]));
  if (proposed.size !== draft.checks.length) throw new Error("Duplicate proposed check identity");
  const fingerprints = new Map<string, string>(), active = new Set<string>();
  const fingerprintFor = (id: string): string => {
    const prior = fingerprints.get(id); if (prior) return prior;
    const check = proposed.get(id); if (!check) throw new Error(`Unknown proposed dependency ${id}`);
    if (active.has(id)) throw new Error(`Check dependency cycle ${id}`);
    active.add(id);
    const { id: _id, successorOf: _successor, dependsOnChecks, ...meaning } = check;
    const fingerprint = contractDigest("check-identity", { ...meaning, requirementRefs: [...meaning.requirementRefs].sort(), prerequisiteRefs: [...meaning.prerequisiteRefs].sort(), dependencies: dependsOnChecks.map(fingerprintFor).sort() });
    active.delete(id); fingerprints.set(id, fingerprint); return fingerprint;
  };
  for (const check of draft.checks) {
    const fingerprint = fingerprintFor(check.id), occurrence = counts.get(fingerprint) ?? 0;
    counts.set(fingerprint, occurrence + 1); mapping.set(check.id, `check-${fingerprint.slice(0, 24)}-${occurrence}`);
  }
  // A provider may copy a host-assigned ID from an earlier draft into a
  // baseline or repair response.  Treat an already allocated ID as
  // idempotently normalized; never remap it through the provider-name map.
  const allocatedIds = new Set(mapping.values());
  const replace = (id: string): string => {
    const replacement = mapping.get(id);
    if (replacement) return replacement;
    if (allocatedIds.has(id)) return id;
    throw new Error(`Unknown proposed check reference ${id}; valid proposed check IDs: ${[...proposed.keys()].join(", ")}; valid allocated check IDs: ${[...allocatedIds].join(", ")}`);
  };
  // Rewrite exact provider-generated check identifiers in provider-authored prose as
  // well as structured references. Never rewrite approved requirements, paths,
  // commands, or generic IDs such as "check" that may also be ordinary words.
  const proseIds = [...mapping.keys()].filter(id => id.startsWith("check-")).sort((a, b) => b.length - a.length);
  const prosePattern = proseIds.length ? new RegExp(`(^|[^A-Za-z0-9_-])(${proseIds.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9_-])`, "g") : undefined;
  const rewrite = (text: string): string => prosePattern ? text.replace(prosePattern, (_match, prefix: string, id: string) => `${prefix}${replace(id)}`) : text;
  for (const check of draft.checks) { check.id = replace(check.id); check.dependsOnChecks = check.dependsOnChecks.map(replace); }
  for (const row of draft.coverage) row.checkIds = row.checkIds.map(replace);
  for (const observation of draft.baseline) if (observation.checkId) observation.checkId = replace(observation.checkId);
  for (const check of draft.checks) {
    check.expectedBehavior = rewrite(check.expectedBehavior); check.expectedEvidence = check.expectedEvidence.map(rewrite);
    if (check.expectedBaseline) check.expectedBaseline = rewrite(check.expectedBaseline);
    if (check.applicability.predicate) check.applicability.predicate = rewrite(check.applicability.predicate);
    check.applicability.requiredEvidence = check.applicability.requiredEvidence.map(rewrite);
    for (const method of check.verification) { method.expectedOutcome = rewrite(method.expectedOutcome); if (method.steps) method.steps = method.steps.map(rewrite); }
  }
  for (const observation of draft.baseline) { observation.procedure = rewrite(observation.procedure); observation.relevance = rewrite(observation.relevance); observation.expectedTransition = rewrite(observation.expectedTransition); if (observation.predicateEvidence) observation.predicateEvidence = observation.predicateEvidence.map(rewrite); }
  for (const evidence of draft.preparationEvidence) evidence.analysis = rewrite(evidence.analysis);
  for (const concern of draft.unresolved) { concern.checkIds = concern.checkIds.map(replace); concern.reason = rewrite(concern.reason); concern.nextAction = rewrite(concern.nextAction); }
  return draft;
}
export function inventoryDigest(requirements: RequirementRef[]): string { return contractDigest("qa-requirement-inventory", requirements); }

/** Derive a missing baseline binding only from an explicit, unique check prerequisite reference. */
export function bindUniqueBaselineCheckIds(candidate: QaContractCandidateV1): QaContractCandidateV1 {
  const draft = structuredClone(candidate);
  for (const observation of draft.baseline) {
    if (observation.checkId) continue;
    const matches = draft.checks.filter(check => check.prerequisiteRefs.includes(observation.id));
    if (matches.length === 1) observation.checkId = matches[0]!.id;
  }
  return draft;
}
export function authoritativeInventory(ticket: TicketDef, checklist: string[], inputs: ContractInputRef[]): RequirementRef[] {
  const result: RequirementRef[] = [];
  for (const [kind, entries] of [["acceptance", ticket.acceptance], ["required_tests", ticket.required_tests], ["checklist", checklist]] as const) {
    const input = inputs.find(ref => ref.kind === (kind === "checklist" ? "checklist" : "ticket"));
    if (!input) throw new Error(`Missing authoritative ${kind} input`);
    const occurrences = new Map<string, number>();
    entries.forEach((statement, index) => {
      const fingerprint = contractDigest("requirement-statement", { kind, statement });
      const occurrence = occurrences.get(fingerprint) ?? 0; occurrences.set(fingerprint, occurrence + 1);
      result.push({ id: `req-${fingerprint.slice(0, 24)}-${occurrence}`, inputRef: input.id, locator: `${kind}[${index}]`, statement,
        digest: contractDigest("statement", statement), obligation: "mandatory", origin: "explicit", authority: "approved" });
    });
  }
  return result;
}
export function parsePreparationArtifact<T>(text: string, tag: string, maximum = 2 * 1024 * 1024): T {
  if (Buffer.byteLength(text) > maximum) throw new Error("QA preparation response exceeds size limit");
  const start = `${tag}_START`, end = `${tag}_END`;
  // Marker names can appear inline in provider prose or in a quoted repair
  // instruction. Only a standalone marker line is an envelope boundary.
  // This keeps the parser strict about malformed envelopes without treating
  // explanatory text as a second/truncated artifact.
  const markerOffsets = (marker: string): number[] => {
    const offsets: number[] = [];
    const pattern = new RegExp(`^[ \\t]*${marker}[ \\t]*$`, "gm");
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) offsets.push(match.index);
    return offsets;
  };
  const starts = markerOffsets(start), ends = markerOffsets(end);
  if (!starts.length || starts.length !== ends.length) throw new Error(`Expected exactly one ${tag} artifact`);
  const artifacts = starts.map((at, index) => {
    const from = at + start.length, to = ends[index]!;
    if (to < from) throw new Error("Malformed preparation artifact envelope");
    return text.slice(from, to).trim();
  });
  if (artifacts.length > 1) {
    const normalized = artifacts.map(artifact => canonicalContractJson(JSON.parse(artifact)));
    if (normalized.some(artifact => artifact !== normalized[0])) throw new Error(`Expected exactly one unambiguous ${tag} artifact`);
  }
  return JSON.parse(artifacts[0]!) as T;
}
/** Capture safe absolute snapshot paths before the disposable snapshot is removed. */
export function mapSnapshotWorkingDirectories(text: string, snapshotPath: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const draft = parsePreparationArtifact<QaContractCandidateV1>(text, "RAFI_QA_CANDIDATE");
    const root = realpathSync(snapshotPath);
    for (const check of draft.checks ?? []) for (const method of check.verification ?? []) {
      if (typeof method.cwd !== "string" || !isAbsolute(method.cwd)) continue;
      try {
        const target = realpathSync(method.cwd);
        const path = relative(root, target);
        if (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path) && statSync(target).isDirectory()) result[method.cwd] = path || ".";
      } catch { /* Missing or inaccessible paths remain invalid. */ }
    }
  } catch { /* Parsing and validation report malformed provider responses. */ }
  return result;
}
/** Providers sometimes repeat an absolute disposable-snapshot path from an earlier
 * conversation.  That path is host-owned and must not enter the durable contract;
 * normalize only the bounded QA snapshot naming convention to stable relative
 * locations before parsing the provider draft. */
export function normalizeSnapshotPaths(text: string): string {
  return text
    .replace(/(?:\/(?:private\/var|var|tmp)(?:\/[^\s"']+)*\/)?rafi-qa-[^\/\s"']+\/scratch(?=[\/"'\s}]|$)/g, "scratch")
    .replace(/(?:\/(?:private\/var|var|tmp)(?:\/[^\s"']+)*\/)?rafi-qa-[^\/\s"']+(?=[\/"'\s}]|$)/g, ".");
}
export function validateCandidate(candidate: QaContractCandidateV1, inventory: RequirementRef[], resolveEquivalent?: EquivalentAuthorityResolver): string[] {
  if (!candidateSchema(candidatePayload(candidate))) return schemaIssues(candidateSchema.errors);
  const issues = validateDepthDecision(candidate.depthDecision);
  if (candidate.version !== 1 || !candidate.contractId || !candidate.runId || !candidate.workId || !candidate.admissionDigest || !Number.isSafeInteger(candidate.revision) || candidate.revision < 1) issues.push("Invalid contract identity");
  for (const field of ["inputs", "baseline", "requirements", "checks", "coverage", "preparationEvidence", "unresolved"] as const) if (!Array.isArray(candidate[field])) issues.push(`Missing ${field} array`);
  if (issues.length) return issues;
  if (candidate.documentation && (!Array.isArray(candidate.documentation.targets) || !Array.isArray(candidate.documentation.criteria))) issues.push("Invalid documentation policy");
  if (candidate.documentation?.required && (!candidate.documentation.targets.length || !candidate.documentation.criteria.length)) issues.push("Documentation policy requires explicit targets and criteria");
  const unique = (items: Array<{ id: string }>, label: string): Set<string> => {
    const ids = new Set<string>(); for (const item of items) { if (!item.id || ids.has(item.id)) issues.push(`Duplicate/missing ${label} ID ${item.id}`); ids.add(item.id); } return ids;
  };
  const inputs = unique(candidate.inputs, "input"), requirements = unique(candidate.requirements, "requirement"), checks = unique(candidate.checks, "check");
  for (const expected of inventory) if (!candidate.requirements.some(actual => canonicalJson(actual) === canonicalJson(expected))) issues.push(`Missing/altered authoritative requirement ${expected.id}`);
  for (const input of candidate.inputs) if (input.availability !== "available" || !/^[a-f0-9]{64}$/.test(input.digest)) issues.push(`Unavailable/invalid input ${input.id}`);
  for (const req of candidate.requirements) {
    if (!inputs.has(req.inputRef) || !req.statement?.trim() || req.digest !== contractDigest("statement", req.statement)) issues.push(`Invalid source/statement ${req.id}`);
    if (req.conflict) issues.push(`Unresolved requirement conflict ${req.id}`);
    if (req.authority === "proposed" && req.obligation === "mandatory") issues.push(`Proposed scope cannot be mandatory ${req.id}`);
    const rows = candidate.coverage.filter(row => row.requirementId === req.id);
    if (rows.length !== 1 || !rows[0]!.checkIds.length || rows[0]!.dispositionRef) issues.push(`Requirement lacks concrete coverage ${req.id}`);
    for (const id of rows[0]?.checkIds ?? []) {
      if (!checks.has(id)) issues.push(`Invalid coverage ${req.id}/${id}: unknown check ID`);
      else if (!candidate.checks.find(check => check.id === id)?.requirementRefs.includes(req.id)) issues.push(`Invalid coverage ${req.id}/${id}: that check's requirementRefs must include ${req.id}`);
    }
    if (req.obligation === "mandatory" && !(rows[0]?.checkIds ?? []).some(id => candidate.checks.find(check => check.id === id)?.obligation === "mandatory")) issues.push(`Mandatory requirement only covered by advisory checks ${req.id}`);
  }
  for (const row of candidate.coverage) if (!requirements.has(row.requirementId)) issues.push(`Unknown coverage requirement ${row.requirementId}`);
  for (const check of candidate.checks) {
    if (!check.requirementRefs?.length || check.requirementRefs.some(id => !requirements.has(id))) issues.push(`Unknown requirement on ${check.id}`);
    if (!check.expectedBehavior?.trim() || !check.expectedEvidence?.length || !check.verification?.length) issues.push(`Nonactionable check ${check.id}`);
    if (!["mandatory", "advisory"].includes(check.obligation) || !["preimplementation", "postimplementation", "both"].includes(check.timing)) issues.push(`Illegal obligation/timing ${check.id}`);
    if (!check.applicability || !["unconditional", "conditional"].includes(check.applicability.kind) || !["host", "qa"].includes(check.applicability.decisionOwner)) issues.push(`Invalid applicability ${check.id}`);
    else if (check.applicability.kind === "conditional" && (!check.applicability.predicate?.trim() || !check.applicability.requiredEvidence?.length)) issues.push(`Underspecified predicate ${check.id}`);
    if (check.obligation === "mandatory" && check.timing !== "postimplementation") {
      const readiness = candidate.baseline.find(observation => observation.checkId === check.id);
      if (!readiness || readiness.applicability === "unresolved" || !readiness.applicability || check.applicability.kind === "unconditional" && readiness.applicability !== "applicable" || readiness.applicability === "applicable" && readiness.status !== "passed" || readiness.applicability === "not-applicable" && !readiness.predicateEvidence?.length) issues.push(`Mandatory preimplementation readiness incomplete ${check.id}`);
      if (check.applicability.kind === "conditional" && readiness?.applicability === "applicable" && !readiness.predicateEvidence?.length) issues.push(`Preimplementation predicate evidence missing ${check.id}`);
    }
    if (check.dispositionRef) issues.push(`Disposition requires resolved persisted authority ${check.id}`);
    for (const method of check.verification ?? []) {
      if (!method.expectedOutcome?.trim() || !method.runtime?.trim() || !Number.isSafeInteger(method.timeoutMs) || method.timeoutMs < 1 || method.timeoutMs > 3_600_000 || method.cwd.startsWith("/") || method.cwd.split(/[\\/]/).includes("..")) issues.push(`Invalid method ${check.id}`);
      if (method.kind === "command" ? !method.argv?.length || method.argv.some(arg => typeof arg !== "string") : method.kind !== "procedure" || !method.steps?.length) issues.push(`Missing verification procedure ${check.id}`);
      if (method.equivalentAuthorityId && !resolveEquivalent?.(method.equivalentAuthorityId, candidate, check, method)) issues.push(`Equivalent method requires persisted authority ${check.id}`);
    }
    if (!Array.isArray(check.dependsOnChecks) || !Array.isArray(check.prerequisiteRefs)) issues.push(`Missing dependencies ${check.id}`);
    for (const id of check.dependsOnChecks ?? []) if (!checks.has(id)) issues.push(`Unknown dependency ${id}`);
    for (const id of check.prerequisiteRefs ?? []) if (!candidate.baseline.some(observation => observation.id === id)) issues.push(`Unknown prerequisite ${id}`);
  }
  const active = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => { if (active.has(id)) { issues.push(`Check dependency cycle ${id}`); return; } if (visited.has(id)) return; active.add(id); for (const dep of candidate.checks.find(check => check.id === id)?.dependsOnChecks ?? []) visit(dep); active.delete(id); visited.add(id); };
  for (const id of checks) visit(id);
  for (const obligation of depthObligations(candidate.depthDecision.level)) if (!candidate.preparationEvidence.some(evidence => evidence.obligation === obligation && evidence.analysis?.trim() && evidence.evidenceDigest && evidence.operationId && evidence.sessionId && evidence.references.length)) issues.push(`Missing depth evidence ${obligation}`);
  for (const concern of candidate.unresolved.filter(item => item.material).slice(0, 5)) issues.push(`Unresolved material concern: ${concern.reason.slice(0, 500)}${concern.nextAction ? `; next action: ${concern.nextAction.slice(0, 300)}` : ""}`);
  if (candidate.unresolved.filter(item => item.material).length > 5) issues.push("Additional material concerns are retained in the preparation record");
  return [...new Set(issues)];
}
export function validateAssessment(candidate: QaContractCandidateV1, assessment: QaSemanticAssessmentV1, authorSessionId: string): string[] {
  const validator = "approach" in assessment ? challengeSchema : assessmentSchema;
  if (!validator(assessment)) return schemaIssues(validator.errors);
  const issues: string[] = [];
  if (assessment.version !== 1 || assessment.draftPayloadDigest !== draftDigest(candidate) || assessment.inventoryDigest !== inventoryDigest(candidate.requirements) || assessment.policyVersion !== candidate.depthDecision.policyVersion) issues.push("Assessment does not bind the exact draft/inventory/policy");
  if (!assessment.operationId || !assessment.sessionId || assessment.sessionId === authorSessionId || assessment.authorSessionId !== authorSessionId) issues.push("Assessment lacks independent authorship");
  for (const req of candidate.requirements) if (!assessment.assessedRequirementIds?.includes(req.id)) issues.push(`Requirement not semantically assessed ${req.id}`);
  for (const obligation of depthObligations(candidate.depthDecision.level)) if (!assessment.assessedObligations?.includes(obligation)) issues.push(`Obligation not assessed ${obligation}`);
  if (!Array.isArray(assessment.concerns)) issues.push("Semantic concerns unresolved");
  else {
    for (const concern of assessment.concerns.filter(item => item.material).slice(0, 5)) issues.push(`Semantic concerns unresolved: ${concern.reason.slice(0, 500)}${concern.nextAction ? `; next action: ${concern.nextAction.slice(0, 300)}` : ""}`);
    if (assessment.concerns.filter(item => item.material).length > 5) issues.push("Additional semantic concerns are retained in the preparation record");
  }
  return issues;
}
export function assembleContract(candidate: QaContractCandidateV1, inventory: RequirementRef[], assessment: QaSemanticAssessmentV1, authorSessionId: string, challenge?: QaChallengeReceiptV1, resolveEquivalent?: EquivalentAuthorityResolver): QaVerificationContractV1 {
  const issues = [...validateCandidate(candidate, inventory, resolveEquivalent), ...validateAssessment(candidate, assessment, authorSessionId)];
  if (candidate.depthDecision.level === 5) {
    if (!challenge) issues.push("Exceptional requires independent challenge");
    else {
      issues.push(...validateAssessment(candidate, challenge, authorSessionId));
      if (!challenge.approach?.trim() || !["scope", "invariants", "failure-boundaries", "verification"].every(category => challenge.concernCategories.includes(category)) || challenge.approachConcerns.some(concern => concern.material)) issues.push("Material approach challenge incomplete");
    }
  }
  if (issues.length) throw new Error(issues.join("; "));
  const body = { ...candidatePayload(candidate), draftPayloadDigest: draftDigest(candidate), semanticAssessmentDigest: contractDigest("artifact-semantic-assessment", assessment), ...(challenge ? { challengeReceiptDigest: contractDigest("artifact-approach-challenge", challenge) } : {}) };
  return { ...body, contentDigest: contractDigest("qa-contract-content", body) };
}
export function verifyContractDigest(contract: QaVerificationContractV1): void {
  const { contentDigest, ...body } = contract;
  if (contentDigest !== contractDigest("qa-contract-content", body) || contract.draftPayloadDigest !== draftDigest(contract)) throw new Error("Corrupt verification contract");
}
export function renderVerificationContract(contract: QaVerificationContractV1): string {
  const documentation = contract.documentation ?? { required: false, targets: [], criteria: [] };
  return [`Verification contract ${contract.contractId}, revision ${contract.revision}`, `Work: ${contract.workId}; digest: ${contract.contentDigest}`, `Depth: ${contract.depthDecision.level}: ${contract.depthDecision.rationale}`, `Documentation required: ${documentation.required ? "yes" : "no"}${documentation.required ? `; targets: ${documentation.targets.join(", ")}; criteria: ${documentation.criteria.join("; ")}` : ""}`,
    ...contract.checks.map(check => [`${check.id}: ${check.obligation}; ${check.timing}; ${check.applicability.kind}`, check.expectedBehavior, check.applicability.predicate ?? "Always applicable", `Evidence: ${check.expectedEvidence.join("; ")}`, ...check.verification.map(method => JSON.stringify(method))].join("\n"))].join("\n\n");
}
