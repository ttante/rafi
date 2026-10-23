#!/usr/bin/env node
// Local protocol fixture: exercise the shipped adapter without provider quota.
const fs = require('node:fs');
const path = require('node:path');
const log = (event) => fs.appendFileSync(process.env.RAFI_RECOVERY_TEST_EVENTS, JSON.stringify(event) + '\n');
if (process.argv[2] !== 'app-server') { log({ kind: 'readiness' }); console.log('OK'); process.exit(0); }
function wire(schema, value, root = schema) {
  if (schema.$ref) return wire(schema.$ref.slice(2).split("/").reduce((node, key) => node[key.replaceAll("~1", "/").replaceAll("~0", "~")], root), value, root);
  const branches = schema.anyOf || schema.oneOf;
  if (branches) {
    const branch = branches.find(b => b.type === "null" ? value === null : value !== null && (b.type !== "object" || typeof value === "object" && !Array.isArray(value) && Object.entries(b.properties || {}).every(([key, f]) => f.const === undefined && !f.enum || f.const === value[key] || f.enum?.includes(value[key]))) && (!b.enum || b.enum.includes(value)));
    return branch ? wire(branch, value, root) : value;
  }
  if (schema.type === "object" && schema.properties && value && typeof value === "object") return Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, value[key] === undefined ? null : wire(child, value[key], root)]));
  if (Array.isArray(value) && schema.items) return value.map(item => wire(schema.items, item, root));
  return value;
}

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
    const operation = p.outputSchema?.properties?.operation?.const;
    if (!operation) throw new Error('Missing native schema');
    let kind = operation === 'build-preflight' ? 'planning' : 'setup';
    let payload = { ready: true };
    let alternative;
    const ticket = /Assigned ticket: (\S+)\./.exec(instruction)?.[1];
    let text = 'STEP_STATUS: done | summary="fixture work complete"';
    if (operation === 'handoff-acceptance') {
      kind = 'handoff'; const match = /Acknowledge manifestDigest ([a-f0-9]+), generation (\d+)/.exec(instruction); payload = { manifestDigest: match[1], generation: Number(match[2]), missingResources: [] };
    } else if (operation === 'qa-verdict') {
      kind = 'qa';
      if (fs.readFileSync(path.join(cwd, 'implemented.txt'), 'utf8') !== 'recovered T001\n') throw new Error('QA did not receive current implementation');
      payload = { kind: 'passed', coverage: null, verifiedInstructionIds: [] };
    } else if (operation === 'work-report') {
      if (!ticket) throw new Error('Builder instruction did not assign a ticket');
      kind = 'builder';
      if (process.env.RAFI_RECOVERY_TEST_BLOCK === ticket) alternative = { kind: 'blocked', reason: 'Rafi is waiting for input', nextAction: 'Resolve fixture blocker' };
      else {
        fs.writeFileSync(path.join(cwd, ticket === 'T001' ? 'implemented.txt' : `${ticket}.txt`), `recovered ${ticket}\n`);
        payload = { disposition: 'modified', evidence: ['implemented.txt'], coverage: null, graphMaintenance: null };
      }
    }
    if (operation === 'build-preflight') payload = { steps: [{ ticket: ticket || null, work: 'Implement authorized work' }] };
    if (operation === 'guided-recovery') payload = { reconciled: true };
    log({ kind, cwd, thread, ticket });
    const id = `turn-${++turn}`;
    send({ id: request.id, result: { turn: { id } } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, tokenUsage: { total: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, last: { totalTokens: 20 }, modelContextWindow: 100000 } } });
    const continuity = { version: 1, decisions: [], constraints: [], discoveries: [], completedActions: [kind], evidence: [], failures: [], blockers: [], openWork: [], nextAction: 'finish T001' };
    text = JSON.stringify(wire(p.outputSchema, { version: 1, operation, result: alternative || { kind: 'completed', summary: 'Fixture work complete', payload }, continuity }));
    send({ method: 'item/completed', params: { threadId: thread, turnId: id, item: { id: `item-${id}`, type: 'agentMessage', phase: 'final_answer', text } } });
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id, status: 'completed' } } });
  } else send({ id: request.id, result: {} });
});
