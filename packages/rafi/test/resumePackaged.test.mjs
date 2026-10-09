import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, chmodSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { stringify } from 'yaml';
import { WorkflowDb } from '../../ai-foreman/dist/workflowDb.js';
import { cmdInit, cmdUpdate } from '../../ai-foreman/dist/tickets/commands.js';
import { buildProjectConfig, defaultAnswers } from '../dist/project.js';

async function cli(root, alias, run, env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url)), alias, root, '--run', run], { env, stdio: ['ignore','pipe','pipe'] });
  let output=''; child.stdout.on('data',data=>output+=data); child.stderr.on('data',data=>output+=data);
  const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
  try { const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,output); }
  finally {clearTimeout(timer);}
}
for (const alias of ['resume','build:resume']) test(`packaged ${alias} cleans terminal history then completes nested preparation recovery`, {timeout:180000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'rafi packaged resume ü '));
  try {
    execFileSync('git',['init','-q',root]);
    writeFileSync(join(root,'rafi-config.yaml'),stringify(buildProjectConfig(defaultAnswers())));
    cmdInit(root,{appName:'Test',timezone:'UTC'});
    writeFileSync(join(root,'.tickets/tickets.yaml'),stringify({tickets:[{id:'T001',order:1,title:'Implement',area:'test',priority:'P1',size:'S',risk:'Low',summary:'work',acceptance:['works'],required_tests:['tests'],likely_files:[],depends_on:[]}]}));
    cmdUpdate(root,'T001',{status:'next',actor:'test'});
    const bin=join(root,'bin');mkdirSync(bin);
    const fixture=fileURLToPath(new URL('./fixtures/interrupted-recovery-codex.cjs',import.meta.url));
    if(process.platform==='win32') {
      // Native executable fixture exercises CreateProcess without relying on
      // shell interpretation. npm shim resolution has its own native tests.
      copyFileSync(process.execPath,join(bin,'codex.exe'));
      writeFileSync(join(root,'exec'),"console.log('OK');");
      writeFileSync(join(root,'app-server'),`process.argv=[process.execPath,'fixture','app-server',...process.argv.slice(2)];require(${JSON.stringify(fixture)});`);
    } else {copyFileSync(fixture,join(bin,'codex'));chmodSync(join(bin,'codex'),0o755);}
    const path=bin+delimiter+process.env.PATH;
    const env={...process.env,RAFI_RECOVERY_TEST_EVENTS:join(root,".rafi/provider-events.jsonl"),PATH:path,...(process.platform==='win32'?{Path:path}:{})};
    let db=new WorkflowDb(root);
    try {
      const owner=db.acquireBuildAdmission('terminal','worker');
      db.beginOwnedPreparationProcess(owner,undefined,true);
      db.transition('terminal',{status:'completed',checkpoint:'terminal',state:{}});
      const dead={...owner,pid:2147483647};
      db.db.prepare('UPDATE build_admission SET record_json=?').run(JSON.stringify(dead));
      const row=db.db.prepare('SELECT id,outcome_json FROM build_owned_processes').get();
      db.db.prepare('UPDATE build_owned_processes SET outcome_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.outcome_json),authority:dead}),row.id);
    } finally {db.close();}
    await cli(root,alias,'terminal',env);
    db=new WorkflowDb(root);
    try {
      assert.equal(db.getRun('terminal').status,'completed');
      assert.deepEqual(db.readinessProcesses(),[]);
      assert.equal(existsSync(join(root,'implemented.txt')),false);
      db.ensureRun('interrupted-preparation');
      db.transition('interrupted-preparation',{checkpoint:'preparing',state:{startArgs:['start',root,'--steps','1','--ticket','T001','--agent','codex','--yes','--no-qa','--no-branch-per-ticket','--completion','none']}});
    } finally {db.close();}
    await cli(root,alias,'interrupted-preparation',env);
    db=new WorkflowDb(root);
    try {
      const successor=db.preparationSuccessor('interrupted-preparation');
      assert.notEqual(successor,'interrupted-preparation');
      assert.equal(db.getRun(successor)?.status,'completed');
      assert.equal(readFileSync(join(root,'implemented.txt'),'utf8'),'recovered T001\n');
      assert.deepEqual(db.readinessProcesses(),[]);
    } finally {db.close();}
  } finally {rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
