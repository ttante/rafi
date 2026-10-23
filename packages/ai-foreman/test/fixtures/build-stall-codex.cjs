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

let turnSequence = 0;
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
    const capabilities = process.env.RAFI_FIXTURE_CAPABILITIES === '1' ? { sandbox: { type: p.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite', networkAccess: p.config?.sandbox_workspace_write?.network_access === true }, approvalPolicy: p.approvalPolicy } : {};
    if (process.env.RAFI_FIXTURE_CAPABILITIES === '1') require('node:fs').appendFileSync(require('node:path').join(cwd, 'fixture-capabilities.jsonl'), JSON.stringify(capabilities) + '\n');
    send({ id: request.id, result: { thread: { id: thread, cwd: p.cwd || process.cwd() }, ...capabilities } });
  } else if (request.method === 'turn/start') {
    const instruction = (p.input || []).map(item => item.text || '').join('\n');
    const assignedTicket = instruction.match(/Assigned ticket: ([^\s.]+)\./)?.[1] || instruction.match(/Ticket scope: ([^\s.]+)\./)?.[1];
    const ticketMarker = assignedTicket ? `ticket="${assignedTicket}" ` : '';
    const operation = p.outputSchema?.properties?.operation?.const;
    if (!operation) throw new Error("Fixture requires native output schema");
    const id = `turn-${++turnSequence}`;
    const emitResult = result => {
      send({ id: request.id, result: { turn: { id } } });
      send({ method: 'item/completed', params: { threadId: thread, turnId: id, item: { id: `item-${id}`, type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(wire(p.outputSchema, { version: 1, operation, result, continuity: delta })) } } });
      send({ method: 'turn/completed', params: { threadId: thread, turn: { id, status: 'completed' } } });
    };
    const isWorkInstruction = operation === 'work-report';
    if (process.env.RAFI_FIXTURE_QUESTION === "1" && !questionAsked && isWorkInstruction) {
      questionAsked = true;
      emitResult({ kind: 'needs-input', question: 'Fixture terminal decision?', choices: ['Continue', 'Cancel'] });
      return;
    }
    if (isWorkInstruction) {
      if (process.env.RAFI_FIXTURE_HANG_WORKER === '1') { require('node:fs').writeFileSync(require('node:path').join(cwd, 'work-started'), String(process.ppid)); process.kill(process.ppid, 'SIGSTOP'); return; }
      if (process.env.RAFI_FIXTURE_WAIT_ON_WORK === '1') { require('node:fs').writeFileSync(require('node:path').join(cwd, 'work-started'), String(process.ppid)); return; }
      if (process.env.RAFI_FIXTURE_CRASH_ON_WORK === '1') { process.kill(process.ppid, 'SIGKILL'); return; }
      require('node:fs').writeFileSync(require('node:path').join(cwd, 'implemented.txt'), 'scripted implementation\n');
    }
    let payload;
    if (operation === 'session-initialization') payload = { ready: true };
    else if (operation === 'build-preflight') payload = { steps: [{ ticket: assignedTicket || null, work: 'Implement authorized work' }] };
    else if (operation === 'handoff-acceptance') { const match = /Acknowledge manifestDigest ([a-f0-9]+), generation (\d+)/.exec(instruction); payload = { manifestDigest: match[1], generation: Number(match[2]), missingResources: [] }; }
    else if (operation === 'guided-recovery') payload = { reconciled: true };
    else if (operation === 'branch-dependency-audit') payload = { dependencies: [] };
    else if (operation === 'manager') payload = { answer: '0 retained build runs. Consult project setup and planning before starting a build.' };
    else if (operation === 'work-report') payload = { disposition: 'modified', evidence: ['implemented.txt'], coverage: null, graphMaintenance: null };
    else throw new Error(`Unsupported fixture operation ${operation}`);
    send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, tokenUsage: { total: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, last: { totalTokens: 20 }, modelContextWindow: 1000 } } });
    emitResult({ kind: 'completed', summary: 'Fixture completed', payload });
  } else send({ id: request.id, result: {} });
});
