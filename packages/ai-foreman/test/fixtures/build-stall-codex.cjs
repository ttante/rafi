#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv[2] !== 'app-server') {
  if (process.env.RAFI_FIXTURE_CRASH_PREPARATION === '1') {
    const fs = require('node:fs');
    const path = require('node:path').join(process.cwd(), 'preparation-crashed');
    if (!fs.existsSync(path)) { fs.writeFileSync(path, 'once'); const worker=Number(require('node:child_process').execFileSync('ps',['-o','ppid=','-p',String(process.ppid)],{encoding:'utf8'}).trim()); if(worker<=1) throw new Error('missing worker'); setTimeout(() => process.kill(worker, 'SIGKILL'), 2000); setInterval(() => {}, 1000); return; }
  }
  console.log('OK'); process.exit(0);
}
let questionAsked = false;
let thread = `scripted-thread-${process.pid}`;
let cwd = process.cwd();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const delta = { version: 1, decisions: [], constraints: [], discoveries: [], completedActions: ['scripted work'], evidence: [], failures: [], blockers: [], openWork: [], nextAction: 'finish' };
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const p = request.params || {};
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    thread = p.threadId || thread;
    cwd = p.cwd || cwd;
    send({ id: request.id, result: { thread: { id: thread, cwd: p.cwd || process.cwd() } } });
  } else if (request.method === 'turn/start') {
    const instruction = (p.input || []).map(item => item.text || '').join('\n');
    if (process.env.RAFI_FIXTURE_QUESTION === "1" && !questionAsked && /You are being run by an automated foreman/.test(instruction)) {
      questionAsked = true;
      send({ id: request.id, result: { turn: { id: 'question-turn' } } });
      send({ method: 'item/completed', params: { threadId: thread, item: { type: 'agentMessage', text: 'STEP_STATUS: needs_input | question="Fixture terminal decision?" choices="Continue|Cancel"\nRAFI_CONTINUITY_DELTA: ' + JSON.stringify(delta) } } });
      send({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'question-turn', status: 'completed' } } });
      return;
    }
    if (/Implement exactly this ticket|You are being run by an automated foreman/.test(instruction)) {
      if (process.env.RAFI_FIXTURE_HANG_WORKER === '1') { require('node:fs').writeFileSync(require('node:path').join(cwd, 'work-started'), String(process.ppid)); process.kill(process.ppid, 'SIGSTOP'); return; }
      if (process.env.RAFI_FIXTURE_WAIT_ON_WORK === '1') { require('node:fs').writeFileSync(require('node:path').join(cwd, 'work-started'), String(process.ppid)); return; }
      if (process.env.RAFI_FIXTURE_CRASH_ON_WORK === '1') { process.kill(process.ppid, 'SIGKILL'); return; }
      require('node:fs').writeFileSync(require('node:path').join(cwd, 'implemented.txt'), 'scripted implementation\n');
    }
    send({ id: request.id, result: { turn: { id: 'turn' } } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, tokenUsage: { total: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, last: { totalTokens: 20 }, modelContextWindow: 1000 } } });
    send({ method: 'item/completed', params: { threadId: thread, item: { type: 'agentMessage', text: (instruction.includes('Reply with HANDOFF_ACCEPTED') ? 'HANDOFF_ACCEPTED\n' : 'STEP_STATUS: done | summary="scripted work complete"\n') + 'RAFI_CONTINUITY_DELTA: ' + JSON.stringify(delta) } } });
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'turn', status: 'completed' } } });
  } else send({ id: request.id, result: {} });
});
