#!/usr/bin/env node
// Local protocol fixture: exercise the shipped adapter without provider quota.
const fs = require('node:fs');
const path = require('node:path');
const log = (event) => fs.appendFileSync(process.env.RAFI_RECOVERY_TEST_EVENTS, JSON.stringify(event) + '\n');
if (process.argv[2] !== 'app-server') { log({ kind: 'readiness' }); console.log('OK'); process.exit(0); }
let cwd = process.cwd();
let thread = `recovery-fixture-${process.pid}`;
let turn = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const p = request.params || {};
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    cwd = p.cwd || cwd; thread = p.threadId || thread;
    send({ id: request.id, result: { thread: { id: thread, cwd } } });
  } else if (request.method === 'turn/start') {
    const instruction = (p.input || []).map(item => item.text || '').join('\n');
    let kind = instruction.includes('Before we begin, list') ? 'planning' : 'setup';
    const ticket = /Assigned ticket: (\S+)\./.exec(instruction)?.[1];
    let text = 'STEP_STATUS: done | summary="fixture work complete"';
    if (instruction.includes('Reply with HANDOFF_ACCEPTED')) {
      kind = 'handoff'; text = 'HANDOFF_ACCEPTED';
    } else if (instruction.includes('Now QA the ticket or step')) {
      kind = 'qa';
      if (fs.readFileSync(path.join(cwd, 'implemented.txt'), 'utf8') !== 'recovered T001\n') throw new Error('QA did not receive current implementation');
      text = 'STEP_STATUS: qa_pass | summary="current T001 implementation verified"';
    } else if (/Implement exactly this ticket|Implement the next ticket or step now|You are being run by an automated foreman/.test(instruction)) {
      if (!ticket) throw new Error('Builder instruction did not assign a ticket');
      kind = 'builder';
      if (process.env.RAFI_RECOVERY_TEST_BLOCK === ticket) text = `STEP_STATUS: blocked | ticket="${ticket}" reason="Rafi is waiting for input"`;
      else {
        fs.writeFileSync(path.join(cwd, ticket === 'T001' ? 'implemented.txt' : `${ticket}.txt`), `recovered ${ticket}\n`);
        text = `STEP_STATUS: done | ticket="${ticket}" summary="fixture work complete"`;
      }
    }
    log({ kind, cwd, thread, ticket });
    const id = `turn-${++turn}`;
    send({ id: request.id, result: { turn: { id } } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, tokenUsage: { total: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, last: { totalTokens: 20 }, modelContextWindow: 100000 } } });
    text += '\nRAFI_CONTINUITY_DELTA: ' + JSON.stringify({ version: 1, decisions: [], constraints: [], discoveries: [], completedActions: [kind], evidence: [], failures: [], blockers: [], openWork: [], nextAction: 'finish T001' });
    send({ method: 'item/completed', params: { threadId: thread, item: { type: 'agentMessage', text } } });
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id, status: 'completed' } } });
  } else send({ id: request.id, result: {} });
});
