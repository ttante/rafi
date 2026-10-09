import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WorkflowDb } from '../dist/workflowDb.js';
import { probeRuntime, RuntimeCleanupError } from '../dist/runtimeReadiness.js';
import { inspectReadiness } from '../dist/readinessCleanup.js';

function provider(root) {
  const script=join(root,'provider.cjs');
  writeFileSync(script,"require('node:fs').appendFileSync('dispatches','1');console.log('OK');");
  if(process.platform==='win32') writeFileSync(join(root,'codex.cmd'),'@echo off\n"%_prog%" "%dp0%/provider.cjs" %*\n');
  else writeFileSync(join(root,'codex'),`#!${process.execPath}\nrequire(${JSON.stringify(script)});`,{mode:0o755});
  return {...process.env,PATH:root,Path:root};
}
for(const fault of ['registration','acknowledgement','cleanup-recording']) test(`packaged readiness ${fault} failure preserves safety and retries`,{timeout:90000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'rafi fault ü '));
  const db=new WorkflowDb(root);const authorize=WorkflowDb.prototype.authorizeReadinessHelper;
  try {
    const authority=db.acquireBuildAdmission('run','worker');const env=provider(root);
    if(fault==='registration') db.db.exec("CREATE TRIGGER injected_fault BEFORE UPDATE OF pid ON build_owned_processes BEGIN SELECT RAISE(ABORT,'registration failed'); END");
    if(fault==='cleanup-recording') db.db.exec("CREATE TRIGGER injected_fault BEFORE UPDATE OF state ON build_owned_processes WHEN NEW.state='quiescent' BEGIN SELECT RAISE(ABORT,'cleanup recording failed'); END");
    if(fault==='acknowledgement') WorkflowDb.prototype.authorizeReadinessHelper=function(...args){authorize.apply(this,args);throw new Error('acknowledgement lost');};
    const options={build:{project:root,runId:'run',authority},env};
    await assert.rejects(probeRuntime(root,'codex',options),RuntimeCleanupError);
    assert.equal(existsSync(join(root,'dispatches')),fault==='cleanup-recording');
    if(fault==='cleanup-recording') {
      assert.equal(db.readinessProcesses().length,1);
      await assert.rejects(probeRuntime(root,'codex',options),/unresolved/);
    }
    if(fault==='acknowledgement') assert.equal(JSON.parse(db.db.prepare('SELECT outcome_json FROM build_owned_processes').get().outcome_json).startup,'authorized');
    db.db.exec('DROP TRIGGER IF EXISTS injected_fault');WorkflowDb.prototype.authorizeReadinessHelper=authorize;
    assert.deepEqual(await db.reconcileReadiness('run',authority),[]);
    const next=await probeRuntime(root,'codex',options);assert.equal(next.ok,true,next.diagnostics);
    assert.deepEqual(db.readinessProcesses(),[]);
  }finally{WorkflowDb.prototype.authorizeReadinessHelper=authorize;db.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('packaged readiness denied identity remains unknown without signalling owner',{timeout:30000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'rafi unknown identity '));const db=new WorkflowDb(root);
  try {
    const owner=db.acquireBuildAdmission('run','worker');const id=db.beginOwnedPreparationProcess(owner,undefined,true);
    db.registerReadinessHelper(id);db.authorizeReadinessHelper(owner,id,process.pid);
    const row=db.readinessProcesses()[0];
    assert.equal(inspectReadiness({...row,process_start:'unavailable'}).state,'unknown');
    assert.equal(inspectReadiness({...row,host:'inaccessible-host'}).state,'unknown');
    assert.throws(()=>db.revokeReadinessHelper(id,owner),/cannot be revoked/);
    assert.throws(()=>db.acquireBuildAdmission('next','worker'));
    // This fixture registers the test process itself. It deliberately does not
    // signal it; read-only denied-identity evidence cannot authorize cleanup.
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test('packaged competing cleanup processes converge before subsequent readiness',{timeout:90000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'rafi competing cleanup '));const db=new WorkflowDb(root);
  try {
    const owner=db.acquireBuildAdmission('old','worker');db.beginOwnedPreparationProcess(owner,undefined,true);
    const dead={...owner,pid:2147483647};db.db.prepare('UPDATE build_admission SET record_json=?').run(JSON.stringify(dead));
    const row=db.readinessProcesses()[0];db.db.prepare('UPDATE build_owned_processes SET outcome_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.outcome_json),authority:dead}),row.id);
    const code=`import {WorkflowDb} from ${JSON.stringify(new URL('../dist/workflowDb.js',import.meta.url).href)};const d=new WorkflowDb(${JSON.stringify(root)},undefined,{runId:'old'});try{if((await d.reconcileReadiness('old')).length)process.exitCode=1;}finally{d.close();}`;
    const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','inherit']});child.once('error',reject);child.once('close',resolve);});
    assert.deepEqual(await Promise.all([run(),run()]),[0,0]);assert.deepEqual(db.readinessProcesses(),[]);
    const authority=db.acquireBuildAdmission('next','worker');const result=await probeRuntime(root,'codex',{build:{project:root,runId:'next',authority},env:provider(root)});assert.equal(result.ok,true,result.diagnostics);
  }finally{db.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('packaged worker death reconciles durable readiness before retry',{timeout:90000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'rafi worker death '));provider(root);
  writeFileSync(join(root,'provider.cjs'),"require('node:fs').writeFileSync('dispatches',String(process.pid));setInterval(()=>{},1000);");
  const code=`import {WorkflowDb} from ${JSON.stringify(new URL('../dist/workflowDb.js',import.meta.url).href)};import {probeRuntime} from ${JSON.stringify(new URL('../dist/runtimeReadiness.js',import.meta.url).href)};const d=new WorkflowDb(${JSON.stringify(root)});const authority=d.acquireBuildAdmission('old','worker');d.close();await probeRuntime(${JSON.stringify(root)},'codex',{build:{project:${JSON.stringify(root)},runId:'old',authority},env:{...process.env,PATH:${JSON.stringify(root)},Path:${JSON.stringify(root)}}});`;
  const worker=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','inherit']});
  let db;
  try {
    const until=Date.now()+30000;
    while(!existsSync(join(root,'dispatches'))&&worker.exitCode===null&&Date.now()<until) await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(existsSync(join(root,'dispatches')),'provider must start before crash');
    const ended=new Promise(resolve=>worker.once('close',resolve));worker.kill('SIGKILL');await ended;
    db=new WorkflowDb(root,undefined,{runId:'old'});
    assert.deepEqual(await db.reconcileReadiness('old',undefined,Date.now()+15000),[]);db.close();db=undefined;
    db=new WorkflowDb(root);const authority=db.acquireBuildAdmission('next','worker');
    const result=await probeRuntime(root,'codex',{build:{project:root,runId:'next',authority},env:provider(root)});assert.equal(result.ok,true,result.diagnostics);
    assert.deepEqual(db.readinessProcesses(),[]);
  } finally {worker.kill('SIGKILL');db?.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
