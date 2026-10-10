import { currentGraphDerivedAccess, registerGraphDerived, graphDerivedAllowed, inheritGraphDerivedAccess, type GraphDerivedAccess } from "./graph/derived.js";
import { bytesDigest } from "./graph/util.js";
import { persistedEquivalentResolver } from "./qaAuthorizedDisposition.js";
import { measureQaPreparation, validateFindingAssessment, validateFindingClassification, type FindingAssessmentV1, type QaMetricEvent } from "./qaPreparationMetrics.js";
import type Database from "better-sqlite3";
import type { QaPreparationConfigV1, QaPreparationDepthDecisionV1, QaPreparationLevel, QaVerificationContractV1, QaContractDeliveryReceiptV1 } from "rafi-spec";
import { canonicalContractJson as canonicalJson } from "./qaVerificationContract.js";
import { contractDigest, verifyContractDigest, validateCandidate, validateAssessment } from "./qaVerificationContract.js";
import { validateDepthDecision } from "./qaPreparationPolicy.js";

export type PreparationState = "preparation-required" | "preparing" | "validating" | "ready" | "incomplete" | "blocked" | "uncertain" | "amendment-required" | "reconciling";
export interface LogicalPreparationBudget {
  id: string; runId: string; workId: string; admissionDigest: string; policy: QaPreparationConfigV1;
  startMs: number; deadlineMs: number; level: QaPreparationLevel;
  reservations: Array<{ operationId: string; kind: "planning" | "investigation" | "assessment" | "challenge" | "escalation" | "repair"; resultId?: string; resultDigest?: string }>;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  extensions: Array<{ authorityId: string; actor: string; reason: string; previousDeadlineMs: number; deadlineMs: number }>;
  caps?: Partial<Record<LogicalPreparationBudget["reservations"][number]["kind"], number>>;
}
export function migrateQaPreparation(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qa_preparation_policy(run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id),record_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qa_preparation_budgets(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),work_id TEXT NOT NULL,admission_digest TEXT NOT NULL,record_json TEXT NOT NULL,UNIQUE(run_id,work_id,admission_digest));
    CREATE TABLE IF NOT EXISTS qa_depth_decisions(decision_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),work_id TEXT NOT NULL,record_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qa_preparation_attempts(operation_id TEXT PRIMARY KEY,budget_id TEXT NOT NULL REFERENCES qa_preparation_budgets(id),state TEXT NOT NULL,intent_json TEXT NOT NULL,result_json TEXT);
    CREATE TABLE IF NOT EXISTS qa_preparation_progress(budget_id TEXT NOT NULL REFERENCES qa_preparation_budgets(id),stage TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(budget_id,stage));
    CREATE TABLE IF NOT EXISTS qa_verification_contracts(digest TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),work_id TEXT NOT NULL,admission_digest TEXT NOT NULL,revision INTEGER NOT NULL,record_json TEXT NOT NULL,UNIQUE(run_id,work_id,admission_digest,revision));
    CREATE TABLE IF NOT EXISTS qa_contract_heads(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),work_id TEXT NOT NULL,admission_digest TEXT NOT NULL,digest TEXT REFERENCES qa_verification_contracts(digest),generation INTEGER NOT NULL,state TEXT NOT NULL,detail TEXT,PRIMARY KEY(run_id,work_id,admission_digest));
    CREATE TABLE IF NOT EXISTS qa_contract_check_history(contract_id TEXT NOT NULL,check_id TEXT NOT NULL,revision INTEGER NOT NULL,meaning_digest TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(contract_id,check_id,revision));
    CREATE TABLE IF NOT EXISTS qa_contract_receipts(operation_id TEXT PRIMARY KEY,contract_digest TEXT NOT NULL REFERENCES qa_verification_contracts(digest),record_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qa_contract_artifacts(digest TEXT PRIMARY KEY,kind TEXT NOT NULL,record_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qa_preparation_events(event_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),work_id TEXT NOT NULL,kind TEXT NOT NULL,record_json TEXT NOT NULL);
  `);
  for (const table of ["qa_preparation_policy", "qa_depth_decisions", "qa_verification_contracts", "qa_contract_check_history", "qa_contract_receipts", "qa_contract_artifacts", "qa_preparation_events"]) {
    for (const action of ["UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER IF NOT EXISTS preparation_immutable_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'Preparation authority and evidence are immutable'); END`);
  }
  const scopes: Record<string, string> = {
    qa_preparation_policy: "ROW.run_id", qa_preparation_budgets: "ROW.run_id", qa_depth_decisions: "ROW.run_id", qa_verification_contracts: "ROW.run_id", qa_contract_heads: "ROW.run_id", qa_preparation_events: "ROW.run_id",
    qa_preparation_attempts: "(SELECT run_id FROM qa_preparation_budgets WHERE id=ROW.budget_id)", qa_preparation_progress: "(SELECT run_id FROM qa_preparation_budgets WHERE id=ROW.budget_id)", qa_contract_receipts: "(SELECT run_id FROM qa_verification_contracts WHERE digest=ROW.contract_digest)",
  };
  for (const [table, scope] of Object.entries(scopes)) for (const action of ["INSERT", "UPDATE", "DELETE"]) {
    const expression = scope.replaceAll("ROW", action === "DELETE" ? "OLD" : "NEW");
    db.exec(`CREATE TRIGGER IF NOT EXISTS preparation_owner_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT CASE WHEN rafi_qa_preparation_owner(${expression})<>1 THEN RAISE(ABORT,'Original preparation owner required') END; END`);
  }
}
/** Tagged enforcing authority also fences older callers that omit new fields. */
export function migrateQaPreparationGuards(db: Database.Database): void {
  const scopes: Record<string, string> = {
    qa_preparation_policy: "ROW.run_id", qa_preparation_budgets: "ROW.run_id", qa_depth_decisions: "ROW.run_id", qa_verification_contracts: "ROW.run_id", qa_contract_heads: "ROW.run_id", qa_preparation_events: "ROW.run_id",
    qa_preparation_attempts: "(SELECT run_id FROM qa_preparation_budgets WHERE id=ROW.budget_id)", qa_preparation_progress: "(SELECT run_id FROM qa_preparation_budgets WHERE id=ROW.budget_id)", qa_contract_receipts: "(SELECT run_id FROM qa_verification_contracts WHERE digest=ROW.contract_digest)",
  };
  for (const [table, scope] of Object.entries(scopes)) for (const action of ["INSERT", "UPDATE", "DELETE"]) {
    const run = scope.replaceAll("ROW", action === "DELETE" ? "OLD" : "NEW");
    db.exec(`CREATE TRIGGER IF NOT EXISTS preparation_lease_${table}_${action} BEFORE ${action} ON ${table}
      WHEN (EXISTS(SELECT 1 FROM build_admission) OR rafi_build_writer_run()<>'' OR EXISTS(SELECT 1 FROM build_runtime_runs WHERE run_id=${run}))
      AND NOT EXISTS(SELECT 1 FROM build_admission WHERE json_extract(record_json,'$.token')=rafi_build_writer_token() AND (json_extract(record_json,'$.runId')=${run} OR EXISTS(SELECT 1 FROM build_child_runs WHERE child=${run} AND parent=json_extract(record_json,'$.runId'))))
      AND NOT (NOT EXISTS(SELECT 1 FROM build_admission) AND EXISTS(SELECT 1 FROM project_lease WHERE owner=rafi_build_lease_owner() AND generation=rafi_build_lease_generation() AND run_id=${run}))
      BEGIN SELECT RAISE(ABORT,'Preparation requires the original durable lease generation'); END`);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS preparation_assignment_guard BEFORE INSERT ON operation_journal
    WHEN NEW.kind='build-assignment' AND EXISTS(SELECT 1 FROM qa_preparation_policy p WHERE p.run_id=NEW.run_id AND json_extract(p.record_json,'$.mode')='enforce')
    AND NOT EXISTS(SELECT 1 FROM qa_contract_heads h JOIN qa_contract_receipts r ON r.contract_digest=h.digest
      WHERE h.run_id=NEW.run_id AND h.work_id=json_extract(NEW.intent_json,'$.ticketId') AND h.admission_digest=json_extract(NEW.intent_json,'$.requirementsDigest') AND h.state='ready'
      AND r.operation_id=json_extract(NEW.intent_json,'$.contractBinding.receiptOperationId') AND h.digest=json_extract(NEW.intent_json,'$.contractBinding.digest')
      AND json_extract(r.record_json,'$.sessionId')=json_extract(NEW.intent_json,'$.contractBinding.session.sessionId')
      AND json_extract(r.record_json,'$.generation')=json_extract(NEW.intent_json,'$.contractBinding.session.generation')
      AND json_extract(r.record_json,'$.workspace')=json_extract(NEW.intent_json,'$.contractBinding.session.workspace')
      AND json_extract(r.record_json,'$.compactionSequence')=json_extract(NEW.intent_json,'$.contractBinding.session.compactionSequence'))
    BEGIN SELECT RAISE(ABORT,'Enforcing assignment requires tagged actual-session contract delivery'); END;
  `);
  const authority = `EXISTS(SELECT 1 FROM qa_contract_heads h JOIN qa_verification_contracts c ON c.digest=h.digest JOIN qa_contract_artifacts a ON a.digest=json_extract(NEW.certificate_json,'$.contractCoverage.coverageDigest')
    WHERE h.run_id=NEW.run_id AND h.work_id=NEW.ticket_id AND h.state='ready' AND h.digest=json_extract(NEW.certificate_json,'$.contractCoverage.contractDigest')
    AND json_extract(NEW.certificate_json,'$.contractCoverage.version')=1 AND c.revision=json_extract(NEW.certificate_json,'$.contractCoverage.revision')
    AND a.kind='final-coverage' AND json_extract(a.record_json,'$.contractDigest')=h.digest
    AND json_extract(a.record_json,'$.sourceDigest')=NEW.source_state_digest AND json_extract(a.record_json,'$.inputBasisDigest')=NEW.review_basis_digest
    AND json_extract(a.record_json,'$.attemptId')=json_extract(NEW.certificate_json,'$.contractCoverage.attemptId') AND json_extract(a.record_json,'$.sessionId')=json_extract(NEW.certificate_json,'$.contractCoverage.sessionId'))`;
  for (const action of ["INSERT", "UPDATE"]) db.exec(`CREATE TRIGGER IF NOT EXISTS preparation_certificate_${action} BEFORE ${action} ON qa_pass_certificates
    WHEN EXISTS(SELECT 1 FROM qa_preparation_policy p WHERE p.run_id=NEW.run_id AND json_extract(p.record_json,'$.mode')='enforce')
    AND (NEW.consumed_by IS NULL OR NEW.consumed_by NOT LIKE 'invalidated:%') AND NOT (${authority})
    BEGIN SELECT RAISE(ABORT,'Enforcing certificate requires current tagged contract coverage'); END`);
}
/** Uses the existing workflow connection and caller's original lease fences. */
export class QaPreparationStore {
  constructor(private readonly db: Database.Database, private readonly assertOwner: (runId: string) => void, private readonly projectDir?: string) {
    db.function("rafi_qa_preparation_owner", (_runId: string) => 1);
  }

  private protectedJson(value: unknown): string {
    const json = canonicalJson(value), access = currentGraphDerivedAccess();
    if (access && (!Array.isArray(access) || access.length)) registerGraphDerived(this.db, json, access);
    return json;
  }
  private decode(value: string): any {
    if (this.projectDir && !graphDerivedAllowed(this.db, this.projectDir, bytesDigest(value)))
      throw new Error("Preparation contains revoked graph-derived evidence; explicit source-based recovery is required");
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='graph_derived_refs'").get()) {
      const row = this.db.prepare("SELECT access_json FROM graph_derived_refs WHERE digest=?").get(bytesDigest(value)) as { access_json: string } | undefined;
      if (row) {
        const access = JSON.parse(row.access_json) as GraphDerivedAccess | GraphDerivedAccess[];
        inheritGraphDerivedAccess(Array.isArray(access) ? access : [access]);
      }
    }
    return JSON.parse(value);
  }
  private atomic<T>(work: () => T): T { return this.db.transaction(work).immediate(); }
  equivalentResolver() { return persistedEquivalentResolver(this.db); }
  metric(runId: string, workId: string, admissionDigest: string, eventId: string, kind: QaMetricEvent["kind"], details: Partial<QaMetricEvent> = {}): void {
    const policy = this.policy(runId); if (!policy) return;
    const budget = this.budget(runId, workId, admissionDigest);
    const existing = this.eventRecord<QaMetricEvent>(eventId);
    const value: QaMetricEvent = { ...details, version: 1, eventId, kind, workKey: `${runId}/${workId}/${admissionDigest}`, admissionDigest, at: existing?.at ?? details.at ?? new Date().toISOString(), mode: existing?.mode ?? policy.mode, level: existing ? existing.level : budget?.level, cohort: existing?.cohort ?? details.cohort ?? `policy:${policy.policyVersion}/level:${budget?.level ?? "unknown"}` };
    if (kind === "finding-classification") validateFindingClassification(value, reference => Boolean(this.db.prepare("SELECT 1 FROM qa_contract_artifacts WHERE digest=?").get(reference)));
    if (kind === "finding-classification" && value.cause !== "unknown") {
      const assessment = this.artifact<FindingAssessmentV1>(value.assessmentRef!, "finding-assessment");
      validateFindingAssessment(assessment);
      const contract = this.contract(assessment.contractDigest);
      if (assessment.findingId !== value.findingId || assessment.cause !== value.cause || assessment.assessor !== value.classifier || contract.runId !== runId || contract.workId !== workId || contract.admissionDigest !== admissionDigest) throw new Error("Supported classification lacks its exact scoped assessment");
    }
    if (kind === "sample") {
      const sample = value.sample;
      if (!sample?.assessor?.trim() || typeof sample.coverageAdequate !== "boolean" || !sample.checkUsefulness?.length) throw new Error("Usefulness sample requires an assessor and specific check observations");
      const contract = this.contract(sample.contractDigest), seen = new Set<string>();
      if (contract.runId !== runId || contract.workId !== workId || contract.admissionDigest !== admissionDigest) throw new Error("Usefulness sample belongs to foreign scope");
      if (contract.preparationEvidence.some(evidence => evidence.sessionId === sample.assessor) || this.receipts(contract.contentDigest).some(receipt => receipt.sessionId === sample.assessor)) throw new Error("Usefulness sampling requires an independent assessor");
      for (const check of sample.checkUsefulness) {
        if (seen.has(check.checkId) || !contract.checks.some(expected => expected.id === check.checkId) || !check.result?.trim() || !check.observation?.trim()) throw new Error("Usefulness sample has unknown, duplicate or unexplained checks");
        seen.add(check.checkId);
      }
      const review = this.db.prepare("SELECT t.receipt_json,b.basis_json FROM qa_review_bases b JOIN qa_turns t ON t.run_id=b.run_id AND t.ticket_id=b.ticket_id AND t.review_basis_digest=b.digest WHERE b.run_id=? AND b.ticket_id=? AND b.digest=? AND t.status='completed'").all(runId, workId, sample.reviewDigest) as Array<{ receipt_json: string; basis_json: string }>;
      if (!review.some(row => JSON.parse(row.basis_json).contractBinding?.digest === contract.contentDigest && JSON.parse(row.receipt_json).terminalEventObserved === true)) throw new Error("Usefulness sample requires a retained terminal review bound to its contract");
      if (!value.evidenceRefs?.length || value.evidenceRefs.some(reference => !this.db.prepare("SELECT 1 FROM qa_contract_artifacts WHERE digest=?").get(reference))) throw new Error("Usefulness sample requires retained input/investigation evidence");
    }
    this.event(runId, workId, eventId, "metric", value);
  }
  findingAssessment(runId: string, workId: string, admissionDigest: string, assessment: FindingAssessmentV1, evidenceRefs: string[]): string {
    this.assertOwner(runId); validateFindingAssessment(assessment);
    const contract = this.contract(assessment.contractDigest);
    if (contract.runId !== runId || contract.workId !== workId || contract.admissionDigest !== admissionDigest || assessment.expectedCheckIds.some(id => !contract.checks.some(check => check.id === id))) throw new Error("Finding classification belongs to foreign scope or checks");
    const finding = this.db.prepare("SELECT b.basis_json FROM qa_findings f JOIN qa_reports r ON r.report_occurrence_id=f.report_occurrence_id JOIN qa_review_bases b ON b.run_id=r.run_id AND b.ticket_id=r.ticket_id AND b.digest=r.review_basis_digest WHERE f.finding_id=? AND r.report_digest=? AND r.run_id=? AND r.ticket_id=?").get(assessment.findingId, assessment.reviewDigest, runId, workId) as { basis_json: string } | undefined;
    if (!finding || JSON.parse(finding.basis_json).contractBinding?.digest !== contract.contentDigest) throw new Error("Finding assessment requires its retained report and contract-bound review basis");
    if ([...assessment.originalInputEvidence, ...assessment.builderEvidence, ...assessment.scopeAuthorityEvidence, ...evidenceRefs].some(reference => !this.db.prepare("SELECT 1 FROM qa_contract_artifacts WHERE digest=?").get(reference))) throw new Error("Finding assessment references unavailable retained evidence");
    if (assessment.independent && (contract.preparationEvidence.some(evidence => evidence.sessionId === assessment.assessor) || this.receipts(contract.contentDigest).some(receipt => receipt.sessionId === assessment.assessor))) throw new Error("Finding assessment cannot attribute independence to the author or Builder");
    const assessmentRef = this.putArtifact("finding-assessment", assessment);
    this.metric(runId, workId, admissionDigest, `metric:finding-assessment:${assessmentRef}`, "finding-classification", { findingId: assessment.findingId, classifier: assessment.assessor, cause: assessment.cause, confidence: assessment.cause === "unknown" ? "unknown" : "supported", evidenceRefs: [...evidenceRefs, assessmentRef], assessmentRef, outsideContract: assessment.cause === "outside-contract" });
    return assessmentRef;
  }
  eventRecord<T>(eventId: string): T | undefined { return this.read<T>("qa_preparation_events", "event_id", eventId); }
  metrics(runId: string) {
    const rows = this.db.prepare("SELECT record_json FROM qa_preparation_events WHERE run_id=? AND kind='metric' ORDER BY rowid").all(runId) as Array<{ record_json: string }>;
    return measureQaPreparation(rows.map(row => this.decode(row.record_json)));
  }
  policy(runId: string): QaPreparationConfigV1 | undefined { return this.read("qa_preparation_policy", "run_id", runId); }
  freezePolicy(runId: string, policy: QaPreparationConfigV1): QaPreparationConfigV1 {
    this.assertOwner(runId);
    return this.atomic(() => {
      const prior = this.policy(runId); if (prior) return prior;
      this.db.prepare("INSERT INTO qa_preparation_policy VALUES(?,?)").run(runId, this.protectedJson(policy)); return policy;
    });
  }
  budget(runId: string, workId: string, admissionDigest: string): LogicalPreparationBudget | undefined {
    const row = this.db.prepare("SELECT record_json FROM qa_preparation_budgets WHERE run_id=? AND work_id=? AND admission_digest=?").get(runId, workId, admissionDigest) as { record_json: string } | undefined;
    return row && this.decode(row.record_json);
  }
  ensureBudget(runId: string, workId: string, admissionDigest: string, level: QaPreparationLevel, nowMs: number): LogicalPreparationBudget {
    this.assertOwner(runId);
    return this.atomic(() => {
      const prior = this.budget(runId, workId, admissionDigest); if (prior) return prior;
      const policy = this.policy(runId); if (!policy) throw new Error("Preparation policy must be frozen before dispatch");
      const id = contractDigest("logical-preparation", { runId, workId, admissionDigest });
      const budget: LogicalPreparationBudget = { id, runId, workId, admissionDigest, policy, level, startMs: nowMs, deadlineMs: nowMs + policy.wallTimeMs[level - 1]!, reservations: [], usage: { inputTokens: null, outputTokens: null, costUsd: null }, extensions: [] };
      this.db.prepare("INSERT INTO qa_preparation_budgets VALUES(?,?,?,?,?)").run(id, runId, workId, admissionDigest, this.protectedJson(budget)); return budget;
    });
  }
  reserve(budget: LogicalPreparationBudget, operationId: string, kind: LogicalPreparationBudget["reservations"][number]["kind"], intent: unknown, nowMs: number, resultId?: string): void {
    this.assertOwner(budget.runId);
    this.atomic(() => {
      const current = this.budget(budget.runId, budget.workId, budget.admissionDigest)!;
      if (nowMs >= current.deadlineMs) throw new Error("Preparation budget exhausted; authorized operational extension required");
      const unresolved = current.reservations.find(item => !item.resultDigest);
      if (unresolved) throw new Error(`Uncertain preparation dispatch ${unresolved.operationId}; reconcile retained result before retry`);
      const count = current.reservations.filter(item => item.kind === kind && (kind !== "repair" || item.resultId === resultId)).length;
      const maximum = current.caps?.[kind] ?? (kind === "planning" ? 1 : kind === "investigation" ? current.level <= 2 ? 2 : 3 : kind === "assessment" ? 3 : 2);
      if (count >= maximum) throw new Error(`Preparation ${kind} allowance exhausted`);
      current.reservations.push({ operationId, kind, ...(resultId ? { resultId } : {}) }); this.saveBudget(current);
      this.db.prepare("INSERT INTO qa_preparation_attempts VALUES(?,?,?,?,NULL)").run(operationId, current.id, "uncertain", this.protectedJson(intent));
    });
  }
  retainResult(budget: LogicalPreparationBudget, operationId: string, result: unknown, usage?: Partial<LogicalPreparationBudget["usage"]>): string {
    this.assertOwner(budget.runId);
    return this.atomic(() => {
      const current = this.budget(budget.runId, budget.workId, budget.admissionDigest)!;
      const reservation = current.reservations.find(item => item.operationId === operationId); if (!reservation) throw new Error("Unreserved preparation result");
      const digest = this.putArtifact("provider-result", result);
      if (reservation.resultDigest && reservation.resultDigest !== digest) throw new Error("Conflicting retained preparation result");
      if (!reservation.resultDigest) {
        reservation.resultDigest = digest;
        for (const key of ["inputTokens", "outputTokens", "costUsd"] as const) if (typeof usage?.[key] === "number") current.usage[key] = (current.usage[key] ?? 0) + usage[key]!;
        this.saveBudget(current);
        this.db.prepare("UPDATE qa_preparation_attempts SET state='validating',result_json=? WHERE operation_id=?").run(this.protectedJson({ digest }), operationId);
      }
      return digest;
    });
  }
  reviseDepth(budget: LogicalPreparationBudget, decision: QaPreparationDepthDecisionV1): void {
    this.assertOwner(budget.runId);
    const issues = validateDepthDecision(decision); if (issues.length) throw new Error(issues.join("; "));
    this.atomic(() => {
      const current = this.budget(budget.runId, budget.workId, budget.admissionDigest)!;
      current.level = decision.level;
      current.deadlineMs = Math.max(current.deadlineMs, current.startMs + current.policy.wallTimeMs[decision.level - 1]!);
      this.saveBudget(current);
      const prior = this.read<QaPreparationDepthDecisionV1>("qa_depth_decisions", "decision_id", decision.decisionId);
      const priorScope = this.db.prepare("SELECT run_id,work_id FROM qa_depth_decisions WHERE decision_id=?").get(decision.decisionId) as { run_id: string; work_id: string } | undefined;
      if (priorScope && (priorScope.run_id !== budget.runId || priorScope.work_id !== budget.workId)) throw new Error("Planner depth identity belongs to another admitted work");
      if (prior && this.protectedJson(prior) !== this.protectedJson(decision)) throw new Error("Conflicting planner depth identity");
      this.db.prepare("INSERT INTO qa_depth_decisions VALUES(?,?,?,?) ON CONFLICT(decision_id) DO NOTHING").run(decision.decisionId, budget.runId, budget.workId, this.protectedJson(decision));
    });
  }
  retainProgress(budget: LogicalPreparationBudget, stage: string, value: unknown): void {
    this.assertOwner(budget.runId);
    const digest = this.putArtifact(`progress-${stage}`, value);
    if (stage === "inventory") { const prior = this.progress(budget, stage); if (prior && this.protectedJson(prior) !== this.protectedJson(value)) throw new Error("Logical preparation inventory changed; authorized amendment required"); }
    this.db.prepare("INSERT INTO qa_preparation_progress VALUES(?,?,?) ON CONFLICT(budget_id,stage) DO UPDATE SET digest=excluded.digest").run(budget.id, stage, digest);
  }
  beginAmendment(budget: LogicalPreparationBudget, inventory: import("rafi-spec").RequirementRef[], authority: { reason: string; inputDigest: string; predecessorDigest: string }): void {
    this.assertOwner(budget.runId);
    this.atomic(() => {
      const head = this.head(budget.runId, budget.workId, budget.admissionDigest);
      if (head.digest !== authority.predecessorDigest || !["ready", "amendment-required", "incomplete", "reconciling", "validating", "preparing"].includes(head.state) || !authority.reason.trim()) throw new Error("Amendment requires current predecessor and explicit input authority");
      const current = this.budget(budget.runId, budget.workId, budget.admissionDigest)!;
      if (current.reservations.some(item => !item.resultDigest)) throw new Error("Uncertain preparation dispatch requires reconciliation before another input amendment");
      const priorInventory = this.progress(budget, "inventory");
      this.putArtifact("amendment-intent", { budgetId: budget.id, priorInventory, inventory, authority });
      this.db.prepare("DELETE FROM qa_preparation_progress WHERE budget_id=? AND stage IN ('draft','assessment','challenge','inventory')").run(budget.id);
      this.retainProgress(budget, "inventory", inventory);
      this.retainProgress(budget, "amendment-inputs", { inputDigest: authority.inputDigest, predecessorDigest: authority.predecessorDigest });
      this.setState(budget.runId, budget.workId, budget.admissionDigest, "reconciling", authority.reason, head.generation);
    });
  }
  progress<T>(budget: LogicalPreparationBudget, stage: string): T | undefined {
    const row = this.db.prepare("SELECT digest FROM qa_preparation_progress WHERE budget_id=? AND stage=?").get(budget.id, stage) as { digest: string } | undefined;
    return row ? this.artifact<T>(row.digest, `progress-${stage}`) : undefined;
  }
  /** Explicit operator action against an answered, exactly scoped durable decision. */
  applyAnsweredExtensions(budget: LogicalPreparationBudget): void {
    const rows = this.db.prepare("SELECT decision_id FROM human_decisions WHERE run_id=? AND status='answered' AND json_extract(decision_json,'$.interruptionId')=? ORDER BY updated_at,decision_id").all(budget.runId, `qa-preparation:${budget.id}`) as Array<{ decision_id: string }>;
    for (const row of rows) this.extendBudget(budget, row.decision_id);
  }
  extendBudget(budget: LogicalPreparationBudget, decisionId: string): void {
    this.assertOwner(budget.runId);
    this.atomic(() => {
      const row = this.db.prepare("SELECT decision_json FROM human_decisions WHERE decision_id=? AND run_id=?").get(decisionId, budget.runId) as { decision_json: string } | undefined;
      const decision = row ? JSON.parse(row.decision_json) as import("rafi-spec").PendingHumanDecision : undefined;
      if (!decision || decision.status !== "answered" || decision.interruptionId !== `qa-preparation:${budget.id}` || !decision.answer || !decision.answeredAt) throw new Error("Budget extension requires an answered scoped operator decision");
      const extension = JSON.parse(decision.answer) as { budgetId: string; reason: string; deadlineMs: number; caps?: LogicalPreparationBudget["caps"] };
      const current = this.budget(budget.runId, budget.workId, budget.admissionDigest)!;
      if (current.extensions.some(item => item.authorityId === decisionId)) return;
      if (extension.budgetId !== budget.id || !extension.reason?.trim() || !Number.isSafeInteger(extension.deadlineMs) || extension.deadlineMs <= current.deadlineMs) throw new Error("Invalid authorized budget extension");
      for (const [kind, maximum] of Object.entries(extension.caps ?? {})) if (!["planning", "investigation", "assessment", "challenge", "escalation", "repair"].includes(kind) || !Number.isSafeInteger(maximum) || maximum! < current.reservations.filter(item => item.kind === kind).length) throw new Error("Budget extension cannot reset consumption");
      current.extensions.push({ authorityId: decisionId, actor: "human", reason: extension.reason, previousDeadlineMs: current.deadlineMs, deadlineMs: extension.deadlineMs });
      current.deadlineMs = extension.deadlineMs; current.caps = { ...current.caps, ...extension.caps }; this.saveBudget(current);
    });
  }
  putArtifact(kind: string, value: unknown): string {
    const digest = contractDigest(`artifact-${kind}`, value);
    this.db.prepare("INSERT INTO qa_contract_artifacts VALUES(?,?,?) ON CONFLICT(digest) DO NOTHING").run(digest, kind, this.protectedJson(value)); return digest;
  }
  artifact<T>(digest: string, kind: string): T {
    const row = this.db.prepare("SELECT record_json FROM qa_contract_artifacts WHERE digest=? AND kind=?").get(digest, kind) as { record_json: string } | undefined;
    if (!row) throw new Error("Missing immutable preparation artifact"); const value = this.decode(row.record_json);
    if (contractDigest(`artifact-${kind}`, value) !== digest) throw new Error("Corrupt preparation artifact"); return value;
  }
  head(runId: string, workId: string, admissionDigest: string): { digest?: string; generation: number; state: PreparationState; detail?: string } {
    const row = this.db.prepare("SELECT digest,generation,state,detail FROM qa_contract_heads WHERE run_id=? AND work_id=? AND admission_digest=?").get(runId, workId, admissionDigest) as ReturnType<QaPreparationStore["head"]> | undefined;
    return row ? { ...row, digest: row.digest ?? undefined, detail: row.detail && this.projectDir && !graphDerivedAllowed(this.db, this.projectDir, bytesDigest(row.detail)) ? "Graph-derived preparation detail withheld; source-based recovery required" : row.detail ?? undefined } : { generation: 0, state: "preparation-required" };
  }
  contract(digest: string): QaVerificationContractV1 {
    const contract = this.read<QaVerificationContractV1>("qa_verification_contracts", "digest", digest);
    if (!contract) throw new Error("Missing verification contract"); verifyContractDigest(contract); return contract;
  }
  setState(runId: string, workId: string, admissionDigest: string, state: PreparationState, detail: string, expectedGeneration: number): void {
    this.assertOwner(runId);
    const access = currentGraphDerivedAccess();
    if (access) registerGraphDerived(this.db, detail, access);
    this.atomic(() => {
      const head = this.head(runId, workId, admissionDigest); if (head.generation !== expectedGeneration) throw new Error("Stale preparation owner/head");
      this.db.prepare("INSERT INTO qa_contract_heads VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,work_id,admission_digest) DO UPDATE SET generation=excluded.generation,state=excluded.state,detail=excluded.detail").run(runId, workId, admissionDigest, head.digest ?? null, head.generation + 1, state, detail);
    });
  }
  publish(contract: QaVerificationContractV1, expectedGeneration: number, nowMs: number): void {
    this.assertOwner(contract.runId); verifyContractDigest(contract);
    this.atomic(() => {
      const assessment = this.artifact<import("rafi-spec").QaSemanticAssessmentV1>(contract.semanticAssessmentDigest, "semantic-assessment");
      const inventory = this.progress<import("rafi-spec").RequirementRef[]>(this.budget(contract.runId, contract.workId, contract.admissionDigest)!, "inventory");
      if (!inventory) throw new Error("Ready publication requires retained authoritative inventory");
      for (const observation of contract.baseline) this.artifact(observation.evidenceDigest, "baseline-observation");
      const issues = [...validateCandidate(contract, inventory, this.equivalentResolver()), ...validateAssessment(contract, assessment, assessment.authorSessionId)];
      if (contract.depthDecision.level === 5) {
        if (!contract.challengeReceiptDigest) issues.push("Missing independent challenge");
        else {
          const challenge = this.artifact<import("rafi-spec").QaChallengeReceiptV1>(contract.challengeReceiptDigest, "approach-challenge");
          issues.push(...validateAssessment(contract, challenge, assessment.authorSessionId));
          if (challenge.approachConcerns.some(concern => concern.material)) issues.push("Unresolved approach concerns");
        }
      }
      if (issues.length) throw new Error(issues.join("; "));
      const head = this.head(contract.runId, contract.workId, contract.admissionDigest);
      const budget = this.budget(contract.runId, contract.workId, contract.admissionDigest);
      if (!budget || nowMs >= budget.deadlineMs || budget.reservations.some(item => !item.resultDigest)) throw new Error("Expired or uncertain preparation cannot publish ready");
      if (head.generation !== expectedGeneration || contract.predecessorDigest !== (head.digest ?? undefined) || contract.revision !== (head.digest ? this.contract(head.digest).revision + 1 : 1)) throw new Error("Stale contract revision/publication");
      if (head.digest) {
        const prior = this.contract(head.digest);
        for (const check of contract.checks) {
          const old = prior.checks.find(row => row.id === check.id);
          if (old && this.protectedJson(old) !== this.protectedJson(check)) throw new Error(`Changed check meaning must allocate a successor: ${check.id}`);
        }
        this.putArtifact("amendment-reconciliation", { predecessor: prior.contentDigest, current: contract.contentDigest, removed: prior.checks.filter(row => !contract.checks.some(check => check.id === row.id)).map(row => row.id), added: contract.checks.filter(row => !prior.checks.some(check => check.id === row.id)).map(row => row.id), carryForward: [], rerun: contract.checks.map(check => check.id), authority: this.head(contract.runId, contract.workId, contract.admissionDigest).detail });
      }
      for (const check of contract.checks) this.db.prepare("INSERT INTO qa_contract_check_history VALUES(?,?,?,?,?)").run(contract.contractId, check.id, contract.revision, contractDigest("check-history", check), this.protectedJson(check));
      this.db.prepare("INSERT INTO qa_verification_contracts VALUES(?,?,?,?,?,?)").run(contract.contentDigest, contract.runId, contract.workId, contract.admissionDigest, contract.revision, this.protectedJson(contract));
      this.db.prepare("INSERT INTO qa_contract_heads VALUES(?,?,?,?,?,'ready',NULL) ON CONFLICT(run_id,work_id,admission_digest) DO UPDATE SET digest=excluded.digest,generation=excluded.generation,state='ready',detail=NULL").run(contract.runId, contract.workId, contract.admissionDigest, contract.contentDigest, head.generation + 1);
    });
  }
  receipt(receipt: QaContractDeliveryReceiptV1): void {
    this.assertOwner(receipt.runId);
    const head = this.head(receipt.runId, receipt.workId, receipt.admissionDigest);
    if (head.state !== "ready" || head.digest !== receipt.contractDigest) throw new Error("Delivery cannot acknowledge stale contract");
    this.db.prepare("INSERT INTO qa_contract_receipts VALUES(?,?,?)").run(receipt.operationId, receipt.contractDigest, this.protectedJson(receipt));
  }
  receipts(digest: string): QaContractDeliveryReceiptV1[] { return (this.db.prepare("SELECT record_json FROM qa_contract_receipts WHERE contract_digest=?").all(digest) as Array<{ record_json: string }>).map(row => this.decode(row.record_json)); }
  event(runId: string, workId: string, eventId: string, kind: string, value: unknown): void {
    this.assertOwner(runId); const json = this.protectedJson(value);
    const prior = this.db.prepare("SELECT record_json FROM qa_preparation_events WHERE event_id=?").get(eventId) as { record_json: string } | undefined;
    if (prior && prior.record_json !== json) throw new Error("Conflicting telemetry replay");
    this.db.prepare("INSERT INTO qa_preparation_events VALUES(?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING").run(eventId, runId, workId, kind, json);
  }
  private saveBudget(budget: LogicalPreparationBudget): void { this.db.prepare("UPDATE qa_preparation_budgets SET record_json=? WHERE id=?").run(this.protectedJson(budget), budget.id); }
  private read<T>(table: string, key: string, value: string): T | undefined { const row = this.db.prepare(`SELECT record_json FROM ${table} WHERE ${key}=?`).get(value) as { record_json: string } | undefined; return row && this.decode(row.record_json); }
}
