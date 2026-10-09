import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WorkflowDb } from '../../ai-foreman/dist/workflowDb.js';
import { createBuildRun, releaseBuildLease, saveBuildRun } from '../../ai-foreman/dist/buildRuns.js';
import { launchDigest } from '../../ai-foreman/dist/buildAdmission.js';
import { classifyProcess } from '../../ai-foreman/dist/processIdentity.js';
import { launchResumeStart, resumeExitCode } from '../dist/resumeLauncher.js';

for(const mode of ['supervised','direct','detached']) test(`packaged established ${mode} recovery claims original run`,{timeout:120000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'rafi established ü '));let db;
  const priorPath=process.env.PATH,priorWindowsPath=process.env.Path;
  try {
    execFileSync('git',['init','-q',root]);const bin=join(root,'bin');mkdirSync(bin);
    const fixture=fileURLToPath(new URL('../../ai-foreman/test/fixtures/build-stall-codex.cjs',import.meta.url));
    if(process.platform==='win32') {
      copyFileSync(process.execPath,join(bin,'codex.exe'));writeFileSync(join(root,'exec'),"console.log('OK');");
      writeFileSync(join(root,'app-server'),`process.argv=[process.execPath,'fixture','app-server',...process.argv.slice(2)];require(${JSON.stringify(fixture)});`);
    }else{copyFileSync(fixture,join(bin,'codex'));chmodSync(join(bin,'codex'),0o755);}
    process.env.PATH=bin+delimiter+priorPath;if(process.platform==='win32')process.env.Path=process.env.PATH;
    let run=createBuildRun({repositoryRoot:root,tickets:[],builder:{role:'builder',source:'project',make:'codex',model:'default',reasoning:'high',fast:false}});
    run=saveBuildRun(root,{...run,recoveryDecision:{version:1,mode:'fresh-recovery-only',runId:run.runId,tickets:[],role:'builder',authoritativeStateDigest:'fixture',settings:run.builder.settings,worktree:root,planUpdateApproval:'auto',decidedAt:new Date().toISOString()}});
    run=releaseBuildLease(root,run,'recoverable');db=new WorkflowDb(root);
    const args=['start',root,'--steps','1','--agent','codex','--yes','--no-qa','--recover-run',run.runId,...(mode==='direct'?['--no-supervisor']:mode==='detached'?['--detach']:[])];
    const authority=db.acquireBuildRecoveryAdmission(run.runId);const launch=db.reserveBuildLaunch(authority,'coordinator',launchDigest(args),'registered-v2');db.dispatchBuildLaunch(authority,launch.token);
    const result=await launchResumeStart(fileURLToPath(new URL('../../ai-foreman/dist/index.js',import.meta.url)),[...args,'--launch-token',launch.token],{authority});
    assert.equal(resumeExitCode(result),0);assert.equal(db.buildLaunch(launch.token).state,'claimed');
    const deadline=Date.now()+60000;
    const finished=()=>{const supervisor=db.supervisorState(run.runId);return db.getRun(run.runId)?.status==='completed'&&(mode!=='detached'||(supervisor?.status==='stopped'&&supervisor.pid&&classifyProcess(supervisor.pid,supervisor.processStart).state==='dead'));};
    while(!finished()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(finished(),'actual CLI must complete before fixture teardown');
    assert.equal(db.preparationSuccessor(run.runId),run.runId);assert.deepEqual(db.readinessProcesses(),[]);
  } finally {
    if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath;
    if(process.platform==='win32'){if(priorWindowsPath===undefined)delete process.env.Path;else process.env.Path=priorWindowsPath;}
    db?.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
