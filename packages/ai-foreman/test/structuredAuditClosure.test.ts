import { HandoffService } from "../src/handoffs.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { WorkflowDb } from '../src/workflowDb.js';
import { WorkflowReader } from '../src/workflowReader.js';
import { journalStructuredDispatch, nativePolicy } from '../src/structuredOperation.js';
import { withSealedDispatch, assertActiveProviderDispatch } from '../src/structuredDispatchAuthority.js';
import { ContinuityAdapter } from '../src/continuity.js';
import { canonicalFixtureTurn } from './helpers/nativeOutput.js';
import { admitFixtureWork, seedQaReceipt } from './helpers/workAdmission.js';
import { workReportOutput } from 'rafi-spec';
const require = createRequire(new URL('../package.json', import.meta.url));
const Database = require('better-sqlite3');
const payload = { disposition: 'modified', evidence: ['Observed'], coverage: null, graphMaintenance: null };
const delta = { version: 1, decisions: [], constraints: [], discoveries: [], completedActions: [], evidence: [], failures: [], blockers: [], openWork: ['continue'], nextAction: 'continue' };
function adapter(root: string, sessionId = "prepared", provider: "claude" | "codex" = "codex") {
  const ref = { version: 1 as const, provider, sessionId, role: 'builder' as const, stream: 'builder', generation: 0, cwd: root, configRoot: root, source: 'observed' as const, createdAt: new Date(0).toISOString(), validatedAt: new Date(0).toISOString() };
  return { agent: provider, sessionId: () => ref.sessionId, sessionRef: () => ref, adoptSessionRef: (next: any) => Object.assign(ref, next), prepareSession: async () => ref,
    sendTurn: async (text: string, policy: any) => {
      assertActiveProviderDispatch(policy, text, provider, ref);
      const match = /Acknowledge manifestDigest ([a-f0-9]+), generation (\d+)/.exec(text);
      return canonicalFixtureTurn(policy, ref.sessionId, policy.output.operation === 'handoff-acceptance'
        ? {manifestDigest: match![1], generation: Number(match![2]), missingResources: []} : payload, provider, undefined, delta);
    },
    async *events() {}, async close() {} };
}
function rawDb(path: string) {
  const db = new Database(path);
  for (const [name, value] of Object.entries({rafi_protocol_v3: 1, rafi_writer_protocol: 4, rafi_structured_communication_protocol: 2,
    rafi_graph_delivery_protocol: 4, rafi_structured_authority_revision: 3, rafi_build_writer_run: '', rafi_build_writer_token: '', rafi_build_lease_owner: '', rafi_build_lease_generation: -1})) db.function(name, () => value);
  return db;
}
function reset(db: any) { db.prepare("DELETE FROM structured_communication_cutover WHERE migration='003_structured_communication_v2_cutover'").run(); }

test('a dispatch rejects capability reminting after its first submission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-remint-')); let sends = 0;
  try {
    const a = adapter(root);
    await assert.rejects(journalStructuredDispatch(root, a, 'work', nativePolicy(workReportOutput, { dispatchId: 'dispatch', journalRunId: 'run' }), async (text, policy) => {
      await a.sendTurn(text, policy); sends++;
      return withSealedDispatch(root, policy.selectedDispatch!, async capability => {
        const result = await a.sendTurn(text, { ...policy, dispatchCapability: capability }); sends++; return result;
      }, a.sessionRef());
    }), /submission claim/);
    assert.equal(sends, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('certificate consumption rejects missing native evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-consume-')); const db = new WorkflowDb(root);
  try {
    db.ensureRun('run'); admitFixtureWork(db, 'run', 'T1');
    let head = db.qaTicketHead('run', 'T1');
    head = db.transitionQa('run', 'T1', head.revision, { type: 'source-frozen', sourceStateDigest: 'source' });
    head = db.transitionQa('run', 'T1', head.revision, { type: 'review-ready', reviewBasisDigest: 'basis', sessionGeneration: 0 });
    head = db.transitionQa('run', 'T1', head.revision, { type: 'turn-intended', slot: 'initial' });
    const certificate = db.issueQaPassCertificate({ runId: 'run', ticketId: 'T1', qaRevision: head.revision + 1, sourceStateDigest: 'source', reviewBasisDigest: 'basis', turnReceiptDigest: seedQaReceipt(db, 'run', 'T1', head.reviewNumber, 'source', 'basis') });
    db.transitionQa('run', 'T1', head.revision, { type: 'review-passed', passCertificateId: certificate.certificateId });
    db.getEvidence = () => undefined;
    assert.throws(() => db.consumeQaPassCertificate('run', 'T1', certificate.certificateId, 'finalizer'), /evidence/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('malformed run JSON is quarantined without blocking readers', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-malformed-')); const db = new WorkflowDb(root);
  db.ensureRun('old'); const path = db.path; db.close();
  try {
    const raw = rawDb(path);
    // Downgraded/corrupt fixture predates current JSON/receipt writer guards.
    for (const {name} of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) raw.exec(`DROP TRIGGER "${name}"`);
    raw.prepare("UPDATE workflow_runs SET state_json='{' WHERE run_id='old'").run(); reset(raw); raw.close();
    const repaired = new WorkflowDb(root);
    assert.equal(repaired.getRun('old')!.status, 'superseded'); repaired.close();
    const reader = new WorkflowReader(root); reader.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a valid native operation cannot hide a legacy pass certificate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-mixed-'));
  try {
    const a = adapter(root);
    await journalStructuredDispatch(root, a, 'work', nativePolicy(workReportOutput, { dispatchId: 'dispatch', journalRunId: 'mixed' }), (text, policy) => a.sendTurn(text, policy));
    const current = new WorkflowDb(root); const path = current.path; current.close();
    const raw = rawDb(path);
    // Legacy fixture: current native-certificate writer guards did not exist.
    for (const {name} of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) raw.exec(`DROP TRIGGER "${name}"`);
    const cert = { version: 2, certificateId: 'legacy-cert', runId: 'mixed', ticketId: 'T1', qaRevision: 1, sourceStateDigest: 'source', reviewBasisDigest: 'basis', turnReceiptDigest: 'legacy-marker-receipt', unresolvedReportCount: 0, issuedAt: new Date(0).toISOString() };
    raw.prepare('INSERT INTO qa_pass_certificates(certificate_id,run_id,ticket_id,qa_revision,source_state_digest,review_basis_digest,turn_receipt_digest,certificate_json,issued_at) VALUES(?,?,?,?,?,?,?,?,?)').run(cert.certificateId, cert.runId, cert.ticketId, 1, cert.sourceStateDigest, cert.reviewBasisDigest, cert.turnReceiptDigest, JSON.stringify(cert), cert.issuedAt);
    reset(raw); raw.close();
    const migrated = new WorkflowDb(root);
    try {
      assert.equal(migrated.getRun('mixed')!.status, 'superseded');
      assert.throws(() => migrated.consumeQaPassCertificate('mixed', 'T1', 'legacy-cert', 'finalizer'), /missing|cannot resume/);
    } finally { migrated.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('receipt-storage failure leaves only the host baseline checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-checkpoint-')); const a = adapter(root);
  const initial = new WorkflowDb(root); initial.ensureRun('run'); initial.close();
  const wrapped = new ContinuityAdapter({ adapter: a, projectDir: root, runId: 'run', role: 'builder', settings: {
    role: 'builder', source: 'project', make: 'codex', model: 'default', reasoning: 'default', fast: false,
    session_strategy: 'compact', settings_revision: 1, display_session_cost: false, auto_compact_threshold_percent: 50, compact_maximum: 1,
  } });
  const original = WorkflowDb.prototype.putEvidence;
  WorkflowDb.prototype.putEvidence = function(kind: any, bytes: Buffer) {
    let value: any; try { value = JSON.parse(bytes.toString()); } catch {}
    if (value?.version === 2 && value.tupleDigest && 'receipt' in value) throw new Error('Simulated receipt storage failure');
    return original.call(this, kind, bytes);
  };
  try {
    await assert.rejects(wrapped.sendTurn('work', nativePolicy(workReportOutput, { dispatchId: 'dispatch' })), /Simulated receipt storage failure/);
    const db = new WorkflowDb(root);
    try {
      assert.equal(db.operation('dispatch')!.status, 'uncertain');
      assert.equal(db.latestContinuityCheckpoint('run', 'builder')!.delta.nextAction, 'Await the first role action.');
      assert.equal(db.continuityCheckpoints('run', 'builder').length, 1, 'provider delta advanced beyond the constructor baseline');
    } finally { db.close(); }
  } finally { WorkflowDb.prototype.putEvidence = original; await wrapped.close(); rmSync(root, { recursive: true, force: true }); }
});


for (const provider of ["claude", "codex"] as const) for (const crashBeforeAdoption of [false,true]) test(`${provider} native handoff has fresh successor authority and restart lineage (crash=${crashBeforeAdoption})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-handoff-'));
  const a = adapter(root, 'predecessor', provider), successor = adapter(root, 'successor', provider);
  a.sendTurn = async (text: string, policy: any) => {
    assertActiveProviderDispatch(policy, text, provider, a.sessionRef());
    return canonicalFixtureTurn(policy, a.sessionId(), undefined, provider, { kind: 'handoff-request', reason: 'Context pressure', roleState: { summary: 'Continue the same work' } }, delta);
  };
  let successorSends = 0;
  const send = successor.sendTurn;
  successor.sendTurn = async (...args) => { if (args[1]?.output.operation !== 'handoff-acceptance') successorSends++; return send(...args); };
  const wrapped = new ContinuityAdapter({ adapter: a, projectDir: root, runId: 'run', role: 'builder', handleHandoffRequest: async (request) => {
    assert.equal(typeof request, 'object');
    const result = await new HandoffService(root).transfer({runId:'run',role:'builder',reason:'native handoff fixture',
      predecessorSessionId:a.sessionId(),predecessorSessionRef:a.sessionRef(),predecessorDispatchId:(request as any).predecessorDispatchId,
      compactionCount:0,compactMaximum:3}, async () => successor);
    return result.successor;
  }, settings: {
    role: 'builder', source: 'project', make: 'codex', model: 'default', reasoning: 'default', fast: false,
    session_strategy: 'compact', settings_revision: 1, display_session_cost: false, auto_compact_threshold_percent: 50, compact_maximum: 1,
  } });
  try {
    if(crashBeforeAdoption) wrapped.adoptValidatedSuccessor=async()=>{throw new Error('Injected crash before successor adoption');};
    let result = await wrapped.sendTurn('work', nativePolicy(workReportOutput, { dispatchId: 'handoff' }));
    if(crashBeforeAdoption) {
      assert.equal(result.isError,true);assert.equal(successorSends,0);
      const recovered=new ContinuityAdapter({adapter:successor,projectDir:root,runId:'run',role:'builder',settings:{
        role:'builder',source:'project',make:'codex',model:'default',reasoning:'default',fast:false,session_strategy:'compact',settings_revision:1,display_session_cost:false,auto_compact_threshold_percent:50,compact_maximum:1}});
      result=(await recovered.resumePlannedContinuation())!;
      assert.equal(result.isError,false);assert.equal(successorSends,1);
      const replay=await recovered.resumePlannedContinuation();assert.equal(replay?.isError,false);assert.equal(successorSends,1);
      await recovered.close();
      return;
    }
    assert.equal(result.isError, false, result.continuityErrors?.join("; "));
    assert.equal(wrapped.sessionId(), 'successor'); assert.equal(successorSends, 1);
    const replay = await wrapped.resumePlannedContinuation(); assert.equal(replay?.isError,false); assert.equal(successorSends,1);
    const db = new WorkflowDb(root);
    try { assert.equal(db.operation('handoff')!.status, 'confirmed'); } finally { db.close(); }
  } finally { await wrapped.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const state of ['{', 'null', '[]', '42', '"scalar"']) test(`repair preserves malformed run state verbatim: ${state}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-invalid-state-'));
  const db = new WorkflowDb(root); db.ensureRun('bad'); db.ensureRun('good'); const path = db.path; db.close();
  try {
    const raw = rawDb(path);
    for (const {name} of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) raw.exec(`DROP TRIGGER "${name}"`);
    raw.prepare('UPDATE workflow_runs SET state_json=? WHERE run_id=?').run(state, 'bad');
    // Exercise an already completed 003 / revision-2 upgrade.
    raw.prepare("DELETE FROM structured_communication_cutover WHERE migration='004_structured_communication_audit_closure'").run();
    raw.close();
    const repaired = new WorkflowDb(root);
    assert.equal(repaired.getRun('bad')!.status, 'superseded');
    assert.equal(repaired.getRun('good')!.status, 'running'); repaired.close();
    const inspect = rawDb(path);
    const archived = inspect.prepare("SELECT row_json FROM structured_cutover_quarantine WHERE run_id='bad' AND table_name='workflow_runs.state_json'").get();
    assert.equal(JSON.parse(archived.row_json).originalBytes, state); inspect.close();
    new WorkflowDb(root).close();
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('confirmed publication recovers once after restart without resending and readers reject lost origin evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-publication-restart-'));
  let sends = 0;
  const raw = adapter(root); const send = raw.sendTurn;
  raw.sendTurn = async (...args) => { sends++; return send(...args); };
  const settings = { role:'builder' as const, source:'project' as const, make:'codex' as const, model:'default', reasoning:'default', fast:false,
    session_strategy:'compact' as const, settings_revision:1, display_session_cost:false, auto_compact_threshold_percent:50, compact_maximum:1 };
  const wrapped = new ContinuityAdapter({adapter:raw,projectDir:root,runId:'run',role:'builder',settings});
  const publish = WorkflowDb.prototype.publishContinuityCheckpoint;
  WorkflowDb.prototype.publishContinuityCheckpoint = function(input, ...args) {
    if (input.origin?.kind === 'provider') throw new Error('Injected checkpoint storage fault');
    return publish.call(this,input,...args);
  };
  try {
    const failed = await wrapped.sendTurn('work',nativePolicy(workReportOutput,{dispatchId:'dispatch'}));
    assert.equal(failed.isError,true);
    const first = new WorkflowDb(root);
    assert.equal(first.operation('dispatch')!.status,'confirmed');
    assert.deepEqual(first.pendingStructuredPostprocessing('run'), ['dispatch']);
    first.close();
    WorkflowDb.prototype.publishContinuityCheckpoint = publish;
    const recovered = new ContinuityAdapter({adapter:raw,projectDir:root,runId:'run',role:'builder',settings});
    await recovered.recoverConfirmedPublications(); await recovered.recoverConfirmedPublications();
    const checked = new WorkflowDb(root);
    assert.equal(checked.continuityCheckpoints('run','builder').length,2);
    const checkpoint = checked.latestContinuityCheckpoint('run','builder')!;
    assert.equal(checkpoint.delta.nextAction,'continue');
    assert.equal(sends,1);
    const receipt = (checked.operation('dispatch')!.result as {responseDigest:string}).responseDigest;
    const path = checked.path; checked.close();
    const tamper = rawDb(path); tamper.prepare('DELETE FROM content_refs WHERE digest=?').run(receipt); tamper.close();
    const reader = new WorkflowReader(root);
    assert.throws(() => reader.continuityHeads('run'), /evidence/); reader.close();
    const writer = new WorkflowDb(root);
    assert.throws(() => writer.latestContinuityCheckpoint('run','builder'), /evidence/); writer.close();
  } finally { WorkflowDb.prototype.publishContinuityCheckpoint=publish; await wrapped.close(); rmSync(root,{recursive:true,force:true}); }
});

for (const mode of [undefined,'off','shadow','enforce'] as const) test(`native certificate replay runs in policy mode ${mode ?? 'default'}`, () => {
  const root=mkdtempSync(join(tmpdir(),'audit-cert-mode-')); const db=new WorkflowDb(root);
  try {
    db.ensureRun('run'); admitFixtureWork(db,'run','T1');
    let head=db.transitionQa('run','T1',0,{type:'source-frozen',sourceStateDigest:'source'});
    head=db.transitionQa('run','T1',head.revision,{type:'review-ready',reviewBasisDigest:'basis',sessionGeneration:0});
    head=db.transitionQa('run','T1',head.revision,{type:'turn-intended',slot:'initial'});
    const certificate=db.issueQaPassCertificate({runId:'run',ticketId:'T1',qaRevision:head.revision+1,sourceStateDigest:'source',reviewBasisDigest:'basis',turnReceiptDigest:seedQaReceipt(db,'run','T1',head.reviewNumber,'source','basis')});
    head=db.transitionQa('run','T1',head.revision,{type:'review-passed',passCertificateId:certificate.certificateId});
    const store=db.qaPreparationStore();
    const policy=store.policy.bind(store);
    store.policy=()=>mode ? {mode} as any : undefined;
    db.qaPreparationStore=()=>store;
    db.getEvidence=()=>undefined;
    assert.throws(()=>db.consumeQaPassCertificate('run','T1',certificate.certificateId,'finalizer'),/evidence/);
    assert.equal(db.qaTicketHead('run','T1').revision,head.revision);
    store.policy=policy;
    const inspect=rawDb(db.path);
    assert.equal(inspect.prepare('SELECT consumed_at FROM qa_pass_certificates WHERE certificate_id=?').get(certificate.certificateId).consumed_at,null); inspect.close();
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test('two child processes race one durable dispatch and restart cannot mint again', async () => {
  const {execFile} = await import('node:child_process');
  const {readFileSync} = await import('node:fs');
  const {selectedDispatchTupleV2,renderProviderWireInstruction,providerWireContract,structuredDigest} = await import('rafi-spec');
  const {sealedDispatchRecord}=await import('../src/structuredDispatchRecord.js');
  const root=mkdtempSync(join(tmpdir(),'audit-claim-processes-')); const a=adapter(root);
  const ref=a.sessionRef(); const db=new WorkflowDb(root);
  try {
    db.ensureRun('run');
    let base: any;
    await journalStructuredDispatch(root,a,'baseline',nativePolicy(workReportOutput,{dispatchId:'baseline',journalRunId:'run'}),async(text,policy)=>{base=policy.selectedDispatch;return a.sendTurn(text,policy);});
    const wire=providerWireContract(workReportOutput,'codex'); const instruction=renderProviderWireInstruction('race',wire);
    const {digest:ignored,...fields}=base;
    const tuple=selectedDispatchTupleV2({...fields,dispatchId:'race',instructionDigest:structuredDigest(instruction)});
    db.planOperation({runId:'run',idempotencyKey:'race',kind:'provider-dispatch',intent:{protocolVersion:2,state:'preparing'}});
    db.sealPlannedOperationIntent('race',{protocolVersion:2,tuple,sealedDispatch:sealedDispatchRecord(tuple),sessionRef:ref});
    db.sealStructuredOwnerDispatch('race',tuple,instruction);db.updateOperation('race','in_progress');
    const authority=new URL('../src/structuredDispatchAuthority.ts',import.meta.url).href;
    const payload={root,tuple,ref,instruction,policy:{output:workReportOutput,wireContract:wire,renderedWireContractDigest:wire.descriptorDigest,dispatchId:'race',selectedDispatch:tuple}};
    // OutputContract includes its validator; the child uses the spec-owned contract.
    const script=`import {withSealedDispatch,assertActiveProviderDispatch} from ${JSON.stringify(authority)};
      import {workReportOutput} from 'file:///Users/tyler/reps/activeWork/rafi-2/packages/spec/dist/index.js'; import {appendFileSync} from 'node:fs';
      const x=JSON.parse(process.env.RAFI_CLAIM_FIXTURE);x.policy.output=workReportOutput;x.policy.selectedDispatch=x.tuple;
      try{await withSealedDispatch(x.root,x.tuple,async capability=>{assertActiveProviderDispatch({...x.policy,dispatchCapability:capability},x.instruction,'codex',x.ref);appendFileSync(x.root+'/sends','sent\\n');},x.ref);process.stdout.write('sent');}
      catch(error){if(!/submission claim/.test(String(error)))throw error;process.stdout.write('blocked');}`;
    const run=()=>new Promise<string>((resolve,reject)=>execFile(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,RAFI_CLAIM_FIXTURE:JSON.stringify(payload)}},(error,stdout,stderr)=>error?reject(new Error(stderr)):resolve(stdout)));
    const results=await Promise.all([run(),run()]);
    assert.deepEqual(results.sort(),['blocked','sent']); assert.equal(readFileSync(join(root,'sends'),'utf8'),'sent\n');
    const restarted=new WorkflowDb(root); assert.throws(()=>restarted.claimStructuredSubmission(tuple,ref),/submission claim/);restarted.close();
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test('a minted capability cannot submit after its owner is failed', async () => {
  const root=mkdtempSync(join(tmpdir(),'audit-revoked-claim-'));const a=adapter(root);
  try {
    await assert.rejects(journalStructuredDispatch(root,a,'work',nativePolicy(workReportOutput,{dispatchId:'revoked',journalRunId:'run'}),async(text,policy)=>{
      const db=new WorkflowDb(root);db.updateOperation('revoked','failed');db.close();
      return a.sendTurn(text,policy);
    }),/no longer in progress/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('provider throws retain bounded UTF-8 diagnostics and never recycle a consumed claim', async () => {
  const root=mkdtempSync(join(tmpdir(),'audit-bounded-throw-')); const a=adapter(root);
  try {
    await assert.rejects(journalStructuredDispatch(root,a,'work',nativePolicy(workReportOutput,{dispatchId:'throw',journalRunId:'run'}),async(text,policy)=>{
      assertActiveProviderDispatch(policy,text,'codex',a.sessionRef()); throw new Error('🧪'.repeat(10000));
    }));
    const db=new WorkflowDb(root);
    try {
      const operation=db.operation('throw')!;assert.equal(operation.status,'uncertain');
      assert.ok(Buffer.byteLength(operation.error!)<=4000);assert.ok(!operation.error!.includes('\ufffd'));
      assert.throws(()=>db.claimStructuredSubmission((operation.intent as any).tuple,a.sessionRef()),/Cannot mint a send capability without a committed sealed owner intent/);
      const persisted=rawDb(db.path);try {assert.equal(persisted.prepare("SELECT state FROM structured_submission_claims WHERE dispatch_id='throw'").get().state,'consumed');} finally {persisted.close();}
    } finally {db.close();}
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('resumed finalization verifies consumed native authority and preserves existing intent on evidence loss', () => {
  const root=mkdtempSync(join(tmpdir(),'audit-finalization-resume-'));const db=new WorkflowDb(root);
  try {
    db.ensureRun('run');admitFixtureWork(db,'run','T1');
    let head=db.transitionQa('run','T1',0,{type:'source-frozen',sourceStateDigest:'source'});
    head=db.transitionQa('run','T1',head.revision,{type:'review-ready',reviewBasisDigest:'basis',sessionGeneration:0});
    head=db.transitionQa('run','T1',head.revision,{type:'turn-intended',slot:'initial'});
    const certificate=db.issueQaPassCertificate({runId:'run',ticketId:'T1',qaRevision:head.revision+1,sourceStateDigest:'source',reviewBasisDigest:'basis',turnReceiptDigest:seedQaReceipt(db,'run','T1',head.reviewNumber,'source','basis')});
    head=db.transitionQa('run','T1',head.revision,{type:'review-passed',passCertificateId:certificate.certificateId});
    db.beginQaFinalization({runId:'run',ticketId:'T1',certificateId:certificate.certificateId,consumer:'finalizer',expectedSourceStateDigest:'source',expectedGitTree:'tree',allowedProjectionPaths:[],expectedRevision:head.revision,operationId:'finalization'});
    assert.doesNotThrow(()=>db.assertQaFinalizationAuthority('run','T1'));
    const revision=db.qaTicketHead('run','T1').revision;
    db.getEvidence=()=>undefined;
    assert.throws(()=>db.assertQaFinalizationAuthority('run','T1'),/evidence/);
    assert.throws(()=>db.completeQaFinalization('run','T1',revision,{done:true}),/evidence/);
    assert.equal(db.qaTicketHead('run','T1').state,'finalizing');
    assert.equal(db.qaFinalizationSteps('run','T1')[0]!.status,'intended');
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

for (const family of ['embedded-completion','provider-session']) test(`unrelated native work cannot legitimize ${family}`, async () => {
  const root=mkdtempSync(join(tmpdir(),'audit-mixed-family-'));
  try {
    const a=adapter(root);
    await journalStructuredDispatch(root,a,'work',nativePolicy(workReportOutput,{dispatchId:'valid',journalRunId:'mixed'}),(text,policy)=>a.sendTurn(text,policy));
    const current=new WorkflowDb(root),path=current.path;current.close();
    const raw=rawDb(path);
    if(family==='embedded-completion')raw.prepare("UPDATE workflow_runs SET state_json=? WHERE run_id='mixed'").run(JSON.stringify({progress:{completedTickets:['legacy-ticket']}}));
    else raw.prepare("INSERT INTO provider_sessions(run_id,role,stream,provider,model,session_id,transition,settings_revision,created_at) VALUES('mixed','builder','builder','codex','default','legacy-session','resumed',1,'now')").run();
    raw.prepare("DELETE FROM structured_communication_cutover WHERE migration='004_structured_communication_audit_closure'").run();raw.close();
    const repaired=new WorkflowDb(root);assert.equal(repaired.getRun('mixed')!.status,'superseded');assert.throws(()=>repaired.assertNativeRunAdmission('mixed'),/cannot resume/);repaired.close();
  } finally {rmSync(root,{recursive:true,force:true});}
});
