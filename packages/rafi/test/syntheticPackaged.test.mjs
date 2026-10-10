import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync,execFileSync} from 'node:child_process';
import {WorkflowDb} from '../../ai-foreman/dist/workflowDb.js';
import {initializeSyntheticWork} from '../../ai-foreman/dist/buildSyntheticWork.js';
import {createBuildRun,checkpointBuildRun,releaseBuildLease,readBuildRuns} from '../../ai-foreman/dist/buildRuns.js';
import {buildProjectConfig,defaultAnswers} from '../dist/project.js';

for(const alias of ['resume','build:resume'])for(const qaEnabled of [false,true])test(`packaged ${alias} keeps frozen synthetic identity with QA ${qaEnabled?'enabled':'disabled'}`,{timeout:90000,skip:process.platform==='win32'},()=>{
  const root=mkdtempSync(join(tmpdir(),'rafi-synthetic-resume-'));
  try {
    const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
    git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.test');
    const config=buildProjectConfig(defaultAnswers());config.agent_defaults={version:1,revision:1,roles:Object.fromEntries(['builder','qa','planner'].map(role=>[role,{make:'codex',model:'default',reasoning:'default',fast:false,session_strategy:'compact'}]))};
    writeFileSync(join(root,'rafi-config.yaml'),JSON.stringify(config));
    writeFileSync(join(root,'.gitignore'),'.rafi/\n.foreman/\nbin/\n');
    writeFileSync(join(root,'source.txt'),'baseline\n');git('add','.');git('commit','-qm','baseline');
    const bin=join(root,'bin');mkdirSync(bin);
    let script=readFileSync(fileURLToPath(new URL('./fixtures/interrupted-recovery-codex.cjs',import.meta.url)),'utf8');
    script=script.replace("ticket === 'T001' ?","(ticket === 'T001' || ticket.startsWith('synthetic:')) ?");
    script=script.replace("!== 'recovered T001\\n'","!== process.env.RAFI_SYNTHETIC_EXPECTED");
    script=script.replace('#!/usr/bin/env node',`#!${process.execPath}`);
    writeFileSync(join(bin,'codex'),script);chmodSync(join(bin,'codex'),0o755);
    const settings=role=>({role,source:'project',make:'codex',model:'default',reasoning:'default',fast:false,session_strategy:'compact'});
    let run=createBuildRun({repositoryRoot:root,tickets:[],builder:settings('builder'),qa:settings('qa'),qaEnabled});
    const [workId]=initializeSyntheticWork(root,run.runId,1,'Explicit unticketed authorization','Implement the bounded source change and validate it independently');
    run=checkpointBuildRun(root,run,'synthetic-interrupted',{tickets:[workId],currentTicket:workId,progress:{completedTickets:[],remainingTickets:[workId]}});
    run=releaseBuildLease(root,run,'recoverable');
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../dist/index.js',import.meta.url)),alias,root,'--run',run.runId,'--yes','--fresh-session'],{encoding:'utf8',timeout:85000,env:{...process.env,PATH:bin+delimiter+process.env.PATH,RAFI_RECOVERY_TEST_EVENTS:join(root,'.rafi/provider-events.jsonl'),RAFI_SYNTHETIC_EXPECTED:`recovered ${workId}\n`}});
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.equal(readFileSync(join(root,'implemented.txt'),'utf8'),`recovered ${workId}\n`);
    const db=new WorkflowDb(root);
    try {assert.deepEqual(db.workDefinitions(run.runId).map(work=>work.workId),[workId]);assert.equal(db.operations(run.runId).filter(operation=>operation.kind==='synthetic-completion'&&operation.status==='confirmed').length,1);if(qaEnabled)assert.equal(db.qaTicketHead(run.runId,workId).state,'completed');}finally{db.close();}
    assert.deepEqual(readBuildRuns(root).find(row=>row.runId===run.runId).progress.completedTickets,[workId]);
  }finally{rmSync(root,{recursive:true,force:true});}
});
