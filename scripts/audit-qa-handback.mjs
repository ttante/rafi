// Read-only coherent audit. No WorkflowDb constructor, migrations, or provider calls.
// Usage: node scripts/audit-qa-handback.mjs /absolute/project/path [...]
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const parse = value => value ? JSON.parse(value) : undefined;
const seconds = (a, b) => a && b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000) : null;
const clean = text => String(text).replace(/((?:api[_-]?key|token|authorization|password|secret)\s*[=:]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1<redacted>').replace(/\b(?:sk|rk|ghp|github_pat)[_-][A-Za-z0-9_-]+\b/g, '<redacted>').slice(0, 1000);
const stats = values => {
  const ordered = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  return { samples: ordered.length, missing: values.length - ordered.length, median: ordered.length ? ordered[Math.floor(ordered.length / 2)] : null, p95: ordered.length ? ordered[Math.ceil(ordered.length * .95) - 1] : null, caveat: 'Observed sample only; small samples and fake-provider host timings do not establish population latency.' };
};

export function auditQaHandback(project) {
  const db = new Database(join(resolve(project), '.rafi/recovery.sqlite3'), { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      const rows = table => tables.has(table) ? db.prepare(`SELECT * FROM ${table}`).all() : [];
      const evidence = digest => digest ? db.prepare('SELECT content FROM content_refs WHERE digest=?').get(digest)?.content : undefined;
      const read = digest => parse(evidence(digest)?.toString());
      const reviews = rows('qa_review_attempts');
      const qaTurns = rows('qa_turns');
      const deliveryTurns = rows('qa_delivery_turns').map(row => parse(row.record_json));
      const remediations = rows('qa_remediation_attempts');
      const invocations = rows('qa_operation_journal').filter(row => row.kind === 'handback-invocation').map(row => parse(row.receipt_json) ?? parse(row.intent_json));
      const handoffs = rows('qa_failure_handoffs').map(handoff => {
        const receipt = read(handoff.receipt_digest);
        const report = read(handoff.parsed_response_digest);
        const turns = deliveryTurns.filter(turn => turn.operationId === handoff.operation_id);
        const prompt = evidence(receipt?.hostInstructionDigest);
        const fullElapsedSeconds = seconds(handoff.created_at, handoff.updated_at);
        const activeSeconds = typeof receipt?.activeElapsedMs === 'number' ? receipt.activeElapsedMs / 1000 : null;
        return {
          runId: handoff.run_id, ticketId: handoff.ticket_id, reviewAttemptId: handoff.review_attempt_id,
          reportOccurrenceId: handoff.report_occurrence_id ?? null, operationId: handoff.operation_id,
          state: handoff.state, outcome: receipt?.outcome ?? 'legacy-unknown', contractAccepted: receipt?.contractAccepted ?? null, qaApproved: false,
          fullElapsedSeconds, activeSeconds, knownPauseSeconds: null,
          unclassifiedGapSeconds: activeSeconds === null || fullElapsedSeconds === null ? null : Math.max(0, fullElapsedSeconds - activeSeconds),
          invocations: invocations.filter(invocation => invocation.operationId === handoff.operation_id || !invocation.operationId && invocation.runId === handoff.run_id && invocation.ticketId === handoff.ticket_id && invocation.reviewAttemptId === handoff.review_attempt_id).map(invocation => ({ invocationId: invocation.invocationId, status: invocation.status, outcome: invocation.outcome ?? null, startedAt: invocation.startedAt, completedAt: invocation.completedAt ?? null, elapsedMs: invocation.elapsedMs ?? null, phases: invocation.phases ?? null })),
          formattingCorrections: turns.length ? turns.filter(turn => turn.kind === 'response-repair').length : null,
          continuityOnlyRepairs: turns.length ? 0 : null, // V3 handbacks prohibit opaque wrapper repair.
          promptEvidenceMatches: prompt && receipt ? Buffer.byteLength(prompt) === receipt.hostInstructionBytes && createHash('sha256').update(prompt).digest('hex') === receipt.hostInstructionDigest : null,
          sourceChanged: receipt?.preDispatchContentDigest && receipt?.postDispatchSourceDigest ? receipt.preDispatchContentDigest !== receipt.postDispatchSourceDigest : null,
          findings: report?.findings?.map(finding => ({ rawId: finding.raw_id, disposition: finding.disposition, verification: finding.verification.map(check => check.outcome) })) ?? null,
          turns: turns.map(turn => ({ turnRecordId: turn.turnRecordId, providerTurnId: turn.providerTurnId ?? null, sessionGeneration: turn.intendedSession.generation, kind: turn.kind, status: turn.status,
            startedAt: turn.startedAt, completedAt: turn.completedAt ?? null, providerElapsedMs: turn.providerElapsedMs ?? null, captureElapsedMs: turn.captureElapsedMs ?? null,
            hostInstructionBytes: turn.hostInstructionBytes, providerInstructionBytes: turn.providerInstructionBytes ?? null,
            rawResponseBytes: turn.rawResponseBytes ?? null, toolCount: turn.toolCount ?? null, terminalCount: turn.terminalCount ?? null,
            correctionReasons: turn.parserErrors?.map(clean) ?? null, validationErrors: turn.validationErrors?.map(clean) ?? null, responseOnlyViolations: turn.responseOnlyViolations?.map(clean) ?? null, validationElapsedMs: turn.validationElapsedMs ?? null,
            evidence: { prompt: turn.hostInstructionDigest, response: turn.rawResponseDigest ?? null, events: turn.eventEvidenceDigest ?? null } })),
        };
      });
      const reports = rows('qa_reports').map(row => { const report = parse(row.report_json); return { runId: row.run_id, ticketId: row.ticket_id, reviewNumber: row.review_number, occurrenceId: row.report_occurrence_id ?? null, digest: row.report_digest, disposition: row.disposition, checks: report?.checks_run?.map(check => ({ outcome: check.outcome })) ?? null }; });
      return {
        project: resolve(project), schemaVersion: db.pragma('user_version', { simple: true }), coherentReadTransaction: true,
        counts: { reviews: reviews.length, qaReportCorrections: qaTurns.filter(turn => /:correction-\d+$/.test(turn.retry_slot)).length, qaSetupTurns: qaTurns.filter(turn => turn.retry_slot === 'session-initialization').length, qaAcknowledgementTurns: qaTurns.filter(turn => /:acknowledgement(?:-repair)?$/.test(turn.retry_slot)).length, remediationOperations: remediations.length, deliveryInvocations: invocations.length, failedInvocations: invocations.filter(invocation => invocation.status === "failed").length, deliveryTurns: deliveryTurns.length, missingTurnJournals: handoffs.filter(handoff => !handoff.turns.length).length,
          formattingCorrections: handoffs.some(handoff => !handoff.turns.length) ? null : deliveryTurns.filter(turn => turn.kind === 'response-repair').length, observedFormattingCorrections: deliveryTurns.filter(turn => turn.kind === 'response-repair').length, legacyUnknownOutcomes: handoffs.filter(handoff => handoff.outcome === 'legacy-unknown').length, blocked: handoffs.filter(handoff => handoff.outcome === 'blocked').length, needsInput: handoffs.filter(handoff => handoff.outcome === 'needs-input').length, uncertain: handoffs.filter(handoff => handoff.outcome === 'delivery-uncertain').length,
          qaConfirmedResolvedOccurrences: reports.filter(report => report.disposition === 'verified-fixed').length,
          packetRevisions: tables.has('qa_packet_projections') ? rows('qa_packet_projections').length : null,
          qaSessionAcceptances: tables.has('qa_handoffs') ? rows('qa_handoffs').filter(row => row.status === 'accepted').length : null },
        reviewSeconds: stats(reviews.map(review => seconds(review.created_at, review.updated_at))),
        activeDeliverySeconds: stats(handoffs.map(handoff => handoff.activeSeconds)), elapsedDeliverySeconds: stats(handoffs.map(handoff => handoff.fullElapsedSeconds)),
        handoffs, reports,
        repeatedNoChangeCandidates: handoffs.filter(handoff => handoff.sourceChanged === false && handoffs.filter(other => other.runId === handoff.runId && other.ticketId === handoff.ticketId && other.sourceChanged === false).length > 1).map(handoff => ({ runId: handoff.runId, ticketId: handoff.ticketId, operationId: handoff.operationId, interpretation: 'Diagnostic only: unchanged source can be a legitimate dispute; this does not infer a blocker, resolution, or waiver.' })),
        invocations: invocations.map(invocation => ({ invocationId: invocation.invocationId, runId: invocation.runId, ticketId: invocation.ticketId, reviewAttemptId: invocation.reviewAttemptId, reportOccurrenceId: invocation.reportOccurrenceId, operationId: invocation.operationId ?? null, status: invocation.status, outcome: invocation.outcome ?? null, startedAt: invocation.startedAt, completedAt: invocation.completedAt ?? null, elapsedMs: invocation.elapsedMs ?? null, phases: invocation.phases ?? null })),
        compactions: rows('compaction_attempts').map(row => ({ role: row.role, status: row.status, error: row.error ? clean(row.error) : null, seconds: seconds(row.created_at, row.updated_at) })),
        sessionAcceptances: rows('handoffs').map(row => ({ role: row.role, state: row.state, seconds: seconds(row.created_at, row.accepted_at) })),
        note: 'Provider and source-capture spans are separate. Active delivery contains preparation and persistence; do not add nested spans to it. Legacy unknowns are not zero. Contract acceptance is never independent QA approval.',
      };
    })();
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const project of process.argv.slice(2)) console.log(JSON.stringify(auditQaHandback(project), null, 2));
}
