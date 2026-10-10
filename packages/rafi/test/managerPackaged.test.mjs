import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkflowDb } from '../../ai-foreman/dist/workflowDb.js';
import { buildProjectConfig, defaultAnswers } from '../dist/project.js';
import { validateQaFailureReport } from 'rafi-spec';
import { prepareOwnershipRepair } from '../../ai-foreman/dist/buildOwnershipRepair.js';

test('built Manager CLI renders a complete retained report without provider setup or database writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rafi-manager-built-'));
  try {
    writeFileSync(join(root, 'rafi-config.yaml'), JSON.stringify(buildProjectConfig(defaultAnswers())));
    const db = new WorkflowDb(root);
    const report = { version: 1, summary: 'large retained report', checks_run: [{ check: 'tests', outcome: 'failed', evidence: 'failed' }], findings: Array.from({ length: 5 }, (_, i) => ({ id: 'QA-' + i, requirement: 'tests', locations: ['a.ts'], problem: '🧪é'.repeat(2000), evidence: 'failed', expected: 'pass', fix_direction: 'repair', verification: ['run tests'] })), observations: ['é'.repeat(1500)] };
    assert.equal(validateQaFailureReport(report).valid, true);
    const body = JSON.stringify(report);
    try {
      db.createRun({ runId: 'run', kind: 'build', originalWork: {}, state: { tickets: ['T001'] } });
      db.admitWork({runId:'run',kind:'ticket',ticketId:'T001',definition:{id:'T001'},approvalId:'fixture',scopeRevision:'fixture',provenance:{userTurn:'Build T001',reason:'Packaged report fixture'}});
      const digest = db.putEvidence('qa', Buffer.from(body));
      db.beginQaReviewAttempt({ attemptId: 'attempt', runId: 'run', ticketId: 'T001', reviewNumber: 1, cycle: 1, remediationGeneration: 0, sourceDigest: 'source' });
      db.finishQaReviewAttempt('attempt', { status: 'failed', reportDigest: digest });
      db.recordQaReport({ runId: 'run', ticketId: 'T001', reviewNumber: 1, sourceStateDigest: 'source', reviewBasisDigest: 'basis', reportDigest: digest, report }, []);
    } finally { db.close(); }
    const path = join(root, '.rafi/recovery.sqlite3'); const before = readFileSync(path);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url)), 'manager', root, '--ask', '/qa-report run T001 attempt'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: '' } });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.ok(cli.stdout.includes(body));
    assert.deepEqual(readFileSync(path), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('built Manager controls enqueue alongside a live owner and refuse ownership repair', () => {
  const root = mkdtempSync(join(tmpdir(), 'rafi-manager-controls-built-'));
  const db = new WorkflowDb(root);
  try {
    writeFileSync(join(root, 'rafi-config.yaml'), JSON.stringify(buildProjectConfig(defaultAnswers())));
    db.ensureRun('run');
    db.admitWork({ runId: 'run', kind: 'ticket', ticketId: 'T1', definition: { acceptance: ['preserve behavior'] }, approvalId: 'approval', scopeRevision: 'scope', provenance: { userTurn: 'Build T1', reason: 'Explicit fixture authorization' } });
    const lease = db.acquireLease('run');
    const command = '/guide-both run T1 Preserve the public behavior and verify independently';
    const invoke = ask => spawnSync(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url)), 'manager', root, '--ask', ask], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: '' } });
    const queued = invoke(command);
    assert.equal(queued.status, 0, queued.stdout + queued.stderr);
    const receipt = JSON.parse(queued.stdout.split('\n')[0]);
    const instruction = db.instruction(receipt.instructionId);
    assert.equal(instruction.request.text, 'Preserve the public behavior and verify independently');
    assert.deepEqual(instruction.deliveries.map(delivery => delivery.state), ['queued', 'queued']);
    assert.equal(db.qaReviewAttempts('run', 'T1').length, 0);
    assert.equal(db.operations('run').length, 0);
    assert.deepEqual(db.currentLease(), lease);
    const status = invoke(`/qa-instruction run T1 ${receipt.instructionId}`);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /queued/);
    assert.deepEqual(db.instruction(receipt.instructionId), instruction);
    const plan = prepareOwnershipRepair(root, 'run', 'T1');
    const request = { version: 1, requestId: 'repair', runId: 'run', workId: 'T1', choice: 'quarantine', expectedRevision: plan.expectedRevision, inspectedSourceDigest: plan.inspectedSourceDigest, scopeRevision: plan.scopeRevision, authorization: 'Quarantine inspected work', attestation: 'Inspected all retained source', mapping: plan.requiredPaths.map(path => ({ path, workId: 'T1' })) };
    const repair = invoke(`/qa-repair ${JSON.stringify(request)}`);
    assert.notEqual(repair.status, 0);
    assert.match(repair.stdout + repair.stderr, /Stop and verify the build owner/);
    assert.equal(db.reconciliation('repair'), undefined);
    assert.equal(db.assertAdmittedWork('run', 'T1').workId, 'T1');
    assert.deepEqual(db.currentLease(), lease);
    db.releaseLease(lease);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('separate one-shot Manager processes render every page and metadata artifact and export scoped raw evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'rafi-manager-pages-built-'));
  let exportPath;
  try {
    writeFileSync(join(root, 'rafi-config.yaml'), JSON.stringify(buildProjectConfig(defaultAnswers())));
    const db = new WorkflowDb(root);
    let occurrence;
    const body = JSON.stringify({ summary: 'retained', password: 'protected-secret', findings: [] });
    try {
      db.createRun({ runId: 'run', kind: 'build', originalWork: {}, state: { tickets: ['T1'] } });
      db.admitWork({ runId: 'run', kind: 'ticket', ticketId: 'T1', definition: { id: 'T1' }, approvalId: 'fixture', scopeRevision: 'fixture', provenance: { userTurn: 'Build T1', reason: 'Explicit fixture' } });
      const digest = db.putEvidence('qa', Buffer.from(body));
      for (let i = 1; i <= 12; i++) {
        db.beginQaReviewAttempt({ attemptId: `attempt-${i}`, runId: 'run', ticketId: 'T1', reviewNumber: i, cycle: i, remediationGeneration: 0, sourceDigest: 'source' });
        db.finishQaReviewAttempt(`attempt-${i}`, { status: 'failed', reportDigest: digest });
        const report = db.recordQaReport({ runId: 'run', ticketId: 'T1', reviewNumber: i, sourceStateDigest: 'source', reviewBasisDigest: 'basis', reportDigest: digest, report: JSON.parse(body) }, []);
        if (i === 12) occurrence = report.reportOccurrenceId;
      }
      db.ensureHumanDecision({ runId: 'run', decisionKey: 'large-question', interruptionId: 'ticket:T1', prompt: 'oversized question '.repeat(4000), choices: [{ id: 'answer', label: 'Answer' }] });
    } finally { db.close(); }
    const databasePath = join(root, '.rafi/recovery.sqlite3'), before = readFileSync(databasePath);
    const invoke = ask => spawnSync(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url)), 'manager', root, '--ask', ask], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: '' } });
    for (const command of ['/qa-attempts run T1', '/qa-timeline run T1']) {
      const cli = invoke(command);
      assert.equal(cli.status, 0, cli.stdout + cli.stderr);
      const page = JSON.parse(cli.stdout);
      assert.equal(page.complete, true);
      assert.equal(page.nextCursor, undefined);
      assert.doesNotMatch(cli.stdout, /metadataArtifact|\/artifact|\/more/);
      if (command.includes('attempts')) assert.equal(page.items.length, 12);
      else assert.ok(cli.stdout.includes('oversized question '.repeat(4000)));
    }
    const display = invoke(`/qa-report run T1 attempt-12 ${occurrence}`);
    assert.equal(display.status, 0, display.stderr);
    assert.doesNotMatch(display.stdout, /protected-secret/);
    const exported = invoke(`/qa-export run T1 attempt-12 ${occurrence}`);
    assert.equal(exported.status, 0, exported.stderr);
    exportPath = /exported to (.+)\n/.exec(exported.stdout)[1];
    assert.equal(readFileSync(exportPath).toString(), body);
    assert.equal(statSync(exportPath).mode & 0o777, 0o600);
    assert.doesNotMatch(exported.stdout, /protected-secret/);
    assert.deepEqual(readFileSync(databasePath), before);
  } finally {
    if (exportPath) rmSync(join(exportPath, '..'), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
