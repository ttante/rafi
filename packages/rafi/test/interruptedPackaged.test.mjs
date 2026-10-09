import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, chmodSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { WorkflowDb } from '../../ai-foreman/dist/workflowDb.js';
import { createBuildRun, releaseBuildLease, checkpointBuildRun, readBuildRuns } from '../../ai-foreman/dist/buildRuns.js';
import { captureFrozenQaSource } from '../../ai-foreman/dist/qaSnapshot.js';
import { cmdInit, cmdUpdate } from '../../ai-foreman/dist/tickets/commands.js';
import { StateDb } from '../../ai-foreman/dist/tickets/stateDb.js';
import { buildProjectConfig, defaultAnswers } from '../dist/project.js';

async function resume(root, alias, runId, env, extra = []) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url)), alias, root, '--run', runId, '--yes', '--fresh-session', ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 150000);
  try { return { code: await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }), output }; }
  finally { clearTimeout(timeout); }
}

for (const alias of ['resume', 'build:resume']) for (const role of ['builder', 'qa']) for (const partial of (role === 'builder' ? [false, true, 'eligible', 'explicit-blocked', 'deferred-first', 'complete-before-checkpoint'] : [false, true])) test(`packaged ${alias} resumes interrupted ${role} ticket through production recovery${partial === 'eligible' ? ' with eligible independent work' : typeof partial === 'string' ? ` ${partial}` : partial ? ' with other work still blocked' : ''}`, { timeout: 180000 }, async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'rafi interrupted ü '));
  const root = join(fixtureRoot, 'project'); mkdirSync(root);
  const events = join(fixtureRoot, 'events.jsonl');
  const observed = () => existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  let db;
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q'); git('config', 'user.email', 'recovery@example.test'); git('config', 'user.name', 'Recovery Test');
    const config = buildProjectConfig(defaultAnswers());
    config.agent_defaults = { version: 1, revision: 1, roles: Object.fromEntries(['builder', 'qa', 'planner'].map(name => [name, { make: 'codex', model: 'default', reasoning: 'default', fast: false, session_strategy: 'compact' }])) };
    writeFileSync(join(root, 'rafi-config.yaml'), stringify(config));
    writeFileSync(join(root, '.gitignore'), '.rafi/\n.foreman/\n.tickets/\n');
    writeFileSync(join(root, 'tracked.txt'), 'baseline\n');
    git('add', '.'); git('commit', '-qm', 'baseline');
    cmdInit(root, { appName: 'Recovery test', timezone: 'UTC' });
    const ticket = { id: 'T001', order: 1, title: 'Recover implementation', area: 'test', priority: 'P1', size: 'S', risk: 'Low', summary: 'Implement T001', acceptance: ['implemented.txt contains recovered T001'], required_tests: ['verify implementation'], likely_files: ['implemented.txt'], depends_on: [] };
    writeFileSync(join(root, '.tickets/tickets.yaml'), stringify({ tickets: partial ? [ticket, { ...ticket, id: 'T002', order: 2, title: 'Implement separate T002 output', summary: 'Implement T002', acceptance: ['T002.txt contains recovered T002'], likely_files: ['T002.txt'] }] : [ticket] }));
    cmdUpdate(root, 'T001', { status: 'in_progress', actor: 'fixture' });
    const bin = join(fixtureRoot, 'bin'); mkdirSync(bin);
    const provider = fileURLToPath(new URL('./fixtures/interrupted-recovery-codex.cjs', import.meta.url));
    if (process.platform === 'win32') {
      copyFileSync(process.execPath, join(bin, 'codex.exe'));
      for (const command of ['exec', 'app-server']) writeFileSync(join(root, command), `process.argv=[process.execPath,'fixture',${JSON.stringify(command)},...process.argv.slice(2)];require(${JSON.stringify(provider)});`);
    } else { copyFileSync(provider, join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o755); }
    const path = bin + delimiter + process.env.PATH;
    const env = { ...process.env, PATH: path, ...(process.platform === 'win32' ? { Path: path } : {}), RAFI_RECOVERY_TEST_EVENTS: events };
    const settings = name => ({ role: name, source: 'project', make: 'codex', model: 'default', reasoning: 'default', fast: false });
    const blockingFirst = partial === 'explicit-blocked' || partial === 'deferred-first';
    if (blockingFirst) env.RAFI_RECOVERY_TEST_BLOCK = 'T001';
    const scope = partial ? ['T001', 'T002'] : ['T001'];
    if (partial) {
      const tickets = new StateDb(join(root, '.tickets/ticket-state.sqlite'));
      try { tickets.upsertState('T002', { status: partial === 'eligible' || blockingFirst ? 'next' : 'blocked', blocker_notes: partial === 'eligible' ? null : 'Separate unresolved work' }, new Date().toISOString()); } finally { tickets.close(); }
    }
    let run = createBuildRun({ repositoryRoot: root, tickets: scope, builder: settings('builder'), qa: settings('qa'), qaEnabled: role === 'qa' });
    run = checkpointBuildRun(root, run, role === 'qa' ? 'qa-review-ready' : 'builder-interrupted');
    let oldAttempt;
    let oldRevision;
    if (role === 'qa') {
      writeFileSync(join(root, 'implemented.txt'), 'recovered T001\n');
      db = new WorkflowDb(root);
      const digest = captureFrozenQaSource(root).digest;
      db.beginQaReviewAttempt({ attemptId: 'interrupted-review', runId: run.runId, ticketId: 'T001', reviewNumber: 1, cycle: 1, remediationGeneration: 0, sourceDigest: digest });
      let head = db.qaTicketHead(run.runId, 'T001');
      head = db.transitionQa(run.runId, 'T001', head.revision, { type: 'source-frozen', sourceStateDigest: digest });
      head = db.transitionQa(run.runId, 'T001', head.revision, { type: 'review-ready', reviewBasisDigest: 'a'.repeat(64), sessionGeneration: 1 });
      db.finishQaReviewAttempt('interrupted-review', { status: 'interrupted', detail: 'Host stopped before dispatching the review' });
      oldAttempt = db.qaReviewAttempt('interrupted-review'); oldRevision = head.revision;
      db.close(); db = undefined;
    }
    run = releaseBuildLease(root, run, 'recoverable');
    assert.equal(readBuildRuns(root).find(item => item.runId === run.runId).recoveryDecision, undefined);
    if (role === 'qa') {
      const stale = await resume(root, alias, run.runId, env, ['--qa-revision', String(oldRevision - 1)]);
      assert.notEqual(stale.code, 0, stale.output); assert.match(stale.output, /stale QA protocol revision/);
      assert.deepEqual(observed(), [], 'stale selection must not start even readiness');
      assert.equal(readBuildRuns(root).find(item => item.runId === run.runId).recoveryDecision, undefined);
    }
    if (partial === 'complete-before-checkpoint') {
      // Tracker commits survived, but the process died before saving run progress.
      const state = new StateDb(join(root, '.tickets/ticket-state.sqlite'));
      try { for (const id of scope) state.upsertState(id, { status: 'done' }, new Date().toISOString()); } finally { state.close(); }
      writeFileSync(join(root, 'implemented.txt'), 'recovered T001\n');
      writeFileSync(join(root, 'T002.txt'), 'recovered T002\n');
      const recovered = await resume(root, alias, run.runId, env);
      assert.equal(recovered.code, 0, recovered.output);
      assert.equal(readBuildRuns(root).find(item => item.runId === run.runId).status, 'completed');
      assert.equal(observed().filter(item => ['builder', 'qa', 'planning'].includes(item.kind)).length, 0, 'completed work must not be dispatched again');
      assert.equal(readFileSync(join(root, 'implemented.txt'), 'utf8'), 'recovered T001\n');
      assert.equal(readFileSync(join(root, 'T002.txt'), 'utf8'), 'recovered T002\n');
      return;
    }
    const result = await resume(root, alias, run.runId, env, partial === 'explicit-blocked' ? ['--ticket', 'T001'] : []);
    if (blockingFirst) {
      assert.equal(result.code, 2, result.output);
      const after = readBuildRuns(root).find(item => item.runId === run.runId);
      assert.deepEqual(after.progress.completedTickets, partial === 'deferred-first' ? ['T002'] : []);
      assert.deepEqual(after.progress.remainingTickets, partial === 'deferred-first' ? ['T001'] : scope);
      assert.equal(after.currentTicket, 'T001');
      assert.equal(existsSync(join(root, 'implemented.txt')), false);
      assert.equal(existsSync(join(root, 'T002.txt')), partial === 'deferred-first');
      assert.deepEqual(after.recoveryDecision.executionTickets, partial === 'explicit-blocked' ? ['T001'] : scope);
      delete env.RAFI_RECOVERY_TEST_BLOCK;
      const second = await resume(root, alias, run.runId, env);
      assert.equal(second.code, 0, second.output);
      assert.equal(readBuildRuns(root).find(item => item.runId === run.runId).status, 'completed');
      assert.equal(readFileSync(join(root, 'implemented.txt'), 'utf8'), 'recovered T001\n');
      assert.equal(readFileSync(join(root, 'T002.txt'), 'utf8'), 'recovered T002\n');
      assert.equal(observed().filter(item => item.kind === 'builder' && item.ticket === 'T002').length, 1);
      return;
    }
    assert.equal(result.code, partial === true ? 2 : 0, result.output);
    db = new WorkflowDb(root);
    assert.equal(db.getRun(run.runId).status, partial === true ? 'paused' : 'completed', result.output);
    assert.equal(db.preparationSuccessor(run.runId), run.runId);
    assert.deepEqual(db.readinessProcesses(), []);
    const completed = readBuildRuns(root).find(item => item.runId === run.runId);
    assert.deepEqual(completed.recoveryDecision.tickets, scope);
    assert.equal(completed.recoveryDecision.mode, 'fresh-recovery-only');
    assert.equal(completed.recoveryDecision.settings.make, 'codex');
    assert.deepEqual(completed.frozenPolicy, run.frozenPolicy);
    assert.deepEqual(completed.progress.completedTickets, partial === 'eligible' ? scope : ['T001']);
    assert.deepEqual(completed.progress.remainingTickets, partial === true ? ['T002'] : []);
    if (partial === true) assert.equal(completed.currentTicket, 'T002');
    assert.equal(readFileSync(join(root, 'implemented.txt'), 'utf8'), 'recovered T001\n');
    if (partial === 'eligible') assert.equal(readFileSync(join(root, 'T002.txt'), 'utf8'), 'recovered T002\n');
    const state = new StateDb(join(root, '.tickets/ticket-state.sqlite'));
    try {
      assert.equal(state.getState('T001').status, 'done');
      if (partial) assert.equal(state.getState('T002').status, partial === 'eligible' ? 'done' : 'blocked');
    } finally { state.close(); }
    assert.equal(observed().filter(item => item.kind === 'builder').length, role === 'builder' ? partial === 'eligible' ? 2 : 1 : 0, JSON.stringify(observed()));
    assert.equal(observed().filter(item => item.kind === 'qa').length, role === 'qa' ? 1 : 0, JSON.stringify(observed()));
    if (role === 'qa') {
      assert.deepEqual(db.qaReviewAttempt('interrupted-review'), oldAttempt);
      const head = db.qaTicketHead(run.runId, 'T001');
      assert.equal(head.state, 'completed'); assert.ok(head.passCertificateId);
      const certificate = JSON.parse(db.db.prepare('SELECT certificate_json FROM qa_pass_certificates WHERE certificate_id=?').get(head.passCertificateId).certificate_json);
      assert.equal(certificate.sourceStateDigest, head.sourceStateDigest);
      const source = JSON.parse(db.db.prepare('SELECT state_json FROM qa_source_states WHERE run_id=? AND ticket_id=? AND digest=?').get(run.runId, 'T001', head.sourceStateDigest).state_json);
      // Tracker publication legitimately changes generated files after QA. Bind
      // the actual implementation bytes to the certified pre-publication source.
      assert.equal(source.paths.find(item => item.path === 'implemented.txt').untracked.digest, createHash('sha256').update(readFileSync(join(root, 'implemented.txt'))).digest('hex'));
      const finalizations = db.qaFinalizationSteps(run.runId, 'T001');
      assert.ok(finalizations.length > 0);
      assert.ok(finalizations.every(step => step.status === 'completed'));
      assert.equal(db.qaReviewAttempts(run.runId, 'T001').filter(item => item.status === 'passed').length, 1);
    }
  } finally { db?.close(); rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
