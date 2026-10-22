/** Opt-in real-provider progression/resume acceptance. No reset/start-over path. */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, openSync, closeSync, existsSync, readdirSync, renameSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { WorkflowReader } from "../../packages/ai-foreman/dist/workflowReader.js";
import { classifyProcess, processGroupQuiescent } from "../../packages/ai-foreman/dist/processIdentity.js";
import { loadTicketsConfig, resolveTicketPaths } from "../../packages/ai-foreman/dist/tickets/config.js";
import { loadTickets } from "../../packages/ai-foreman/dist/tickets/ticketLoader.js";
import { resolveProviderSessionAvailability } from "../../packages/ai-foreman/dist/sessionAvailability.js";
import { recoverableBuildRuns } from "../../packages/ai-foreman/dist/buildRuns.js";
import { captureCurrentWorkflowSessionIdentity } from "../../packages/ai-foreman/dist/branch/currentGuard.js";
import { createLiveWorkspace, liveProjectPath } from "./workspace.mjs";

if (process.env.RAFI_LIVE_MULTITICKET !== "1") throw new Error("Explicit online authorization and RAFI_LIVE_MULTITICKET=1 required");
const deadline = Date.parse(process.env.RAFI_LIVE_DEADLINE ?? "");
assert.ok(Number.isFinite(deadline) && deadline > Date.now(), "Authorized absolute deadline required");
const providers = (process.env.RAFI_LIVE_PROVIDERS ?? "claude,codex").split(",");
const scenarios = (process.env.RAFI_LIVE_SCENARIOS ?? "consecutive,graceful,abrupt").split(",");
assert.ok(providers.every(p => ["claude", "codex"].includes(p)));
assert.ok(scenarios.every(s => ["consecutive", "graceful", "abrupt", "qa", "qa-continuation", "qa-fix", "qa-fix-clean", "qa-fix-final", "boundary"].includes(s)));
const ticketCount = scenario => scenario.startsWith("qa-fix") || scenario === "qa-continuation" || process.env.RAFI_LIVE_FOCUSED_FIVE === "1" && ["qa","boundary"].includes(scenario) ? 5 : 8;
const cli = resolve(fileURLToPath(new URL("../../packages/rafi/dist/index.js", import.meta.url)));
const liveWorkspace = createLiveWorkspace("rafi-live-multiticket-", { evidenceRoot: process.env.RAFI_LIVE_EVIDENCE });
const root = liveWorkspace.evidenceRoot;
const workspaceRoot = liveWorkspace.workspaceRoot;
if (process.env.RAFI_LIVE_EVIDENCE) assert.ok(root.includes("/rafi-live-multiticket-"), "Disposable evidence root only");
const ledger = existsSync(join(root, "ledger.json")) ? JSON.parse(readFileSync(join(root, "ledger.json"), "utf8")).ledger : [];
const save = () => writeFileSync(join(root, "ledger.json"), JSON.stringify({ profile: "online-only multi-ticket and same-build resume", providers, scenarios, deadline: new Date(deadline).toISOString(), evidenceRoot: root, providerWorkspaceRoot: workspaceRoot, ledger }, null, 2));
const features = ["subtract", "multiply", "divide", "modulo", "power", "clamp", "sum", "mean"];
const brief = [
  "Extend this private arithmetic library with exactly EIGHT distinct substantive implementation tickets, one per exported function, in this order:",
  "1 subtract(a,b): subtraction; 2 multiply(a,b): multiplication; 3 divide(a,b): division, throw RangeError for zero divisor; 4 modulo(a,b): JavaScript remainder, throw RangeError for zero divisor; 5 power(a,b): exponentiation; 6 clamp(value,min,max): inclusive bounds, throw RangeError if min>max; 7 sum(values): sum an array, empty=0, using existing add; 8 mean(values): use sum and divide, throw RangeError for empty array.",
  "Each function lives in its own src/<function>.mjs module, is exported by index.mjs, and has its own Node test file covering ordinary positive, negative, zero and specified error/boundary cases. Preserve existing add and all previously completed functions/tests. sum depends on existing add; mean depends on completed sum and divide. Each ticket validates only its own acceptance and existing completed behavior; do NOT demand unfinished later features during QA.",
  "Use no dependencies, no external services, no dependency acquisition, no publishing/deployments, no remote Git actions. Current branch, no product commits required. Use npm test. Public API is exact names/signatures above. Plan exactly these eight tickets now with reasonable defaults; no clarification questions. Small numerical feature work needs no new architecture/framework or additional meta-tickets.",
].join("\n");
const focusedBrief = [
  "Extend this private arithmetic library with exactly FIVE implementation tickets in this order: subtract(a,b), multiply(a,b), divide(a,b), modulo(a,b), power(a,b).",
  "Subtract performs subtraction, multiply multiplication, divide division and modulo JavaScript remainder; divide and modulo throw RangeError for zero divisor. Power performs exponentiation.",
  "Each function has its own src/<function>.mjs module, is exported by index.mjs, and has its own Node test file covering ordinary positive, negative, zero and specified errors. Preserve existing add and previously completed functions/tests. Each ticket validates only its own acceptance and completed behavior, never unfinished later features.",
  "Use no dependencies, services, acquisition, publishing, deployments or remote Git. Current branch, no product commits required. Use npm test. Plan exactly these five substantive tickets now with defaults and no clarification questions or extra meta-tickets.",
].join("\n");
save(); console.log(`Multi-ticket evidence: ${root}`);
function inspect(project) {
  const reader = new WorkflowReader(project);
  const paths = resolveTicketPaths(loadTicketsConfig(project), project);
  const tracker = new Database(paths.stateDb, { readonly: true, fileMustExist: true });
  const recovery = new Database(reader.path, { readonly: true, fileMustExist: true });
  try {
    const run = reader.buildRuns(true)[0];
    assert.ok(run, "No build run");
    const tickets = tracker.prepare("SELECT * FROM ticket_state ORDER BY ticket_id").all();
    const qa = recovery.prepare("SELECT * FROM qa_ticket_heads WHERE run_id=? ORDER BY ticket_id").all(run.runId);
    const completed = tickets.filter(t => t.status === "done" && qa.some(q => q.ticket_id === t.ticket_id && q.state === "completed"));
    return { run, tickets, qa, completed, operations: reader.operations(run.runId, true), events: reader.events(run.runId), lease: reader.currentLease(), admission: reader.buildAdmission(), readiness: reader.readinessProcesses(), decisions: reader.pendingHumanDecisions(run.runId) };
  } finally { recovery.close(); tracker.close(); reader.close(); }
}
async function quarantineOwnPredecessor(project, provider, scenario, paused) {
  const ref = paused.operations.filter(op => op.kind === "provider-dispatch" && ["in_progress","uncertain"].includes(op.status) && op.intent.role === "builder").at(-1)?.intent.sessionRef;
  assert.ok(ref?.validatedAt && ref.source === "observed" && ref.provider === provider);
  assert.equal(realpathSync(ref.cwd),realpathSync(project)); assert.equal(realpathSync(ref.configRoot),realpathSync(project));
  assert.ok(/^[a-f0-9-]{36}$/.test(ref.sessionId));
  const worker=paused.events.filter(event=>event.type==="worker_started").at(-1)?.payload;
  assert.ok(worker?.workerPid && classifyProcess(worker.workerPid,worker.processStart,worker.host).state==="dead" && processGroupQuiescent(worker.workerPid),"Original disposable worker/group must be stopped before native history quarantine");
  const probeOptions={cwd:project,configRoot:project,workspaceIdentity:captureCurrentWorkflowSessionIdentity(project)};
  const available = await resolveProviderSessionAvailability(ref,probeOptions);
  assert.equal(available.status,"available","Only a verified newly generated disposable-project session may be quarantined");
  const history = provider === "claude" ? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(),".claude"),"projects") : join(process.env.CODEX_HOME ?? join(homedir(),".codex"),"sessions");
  const files=[];
  const visit=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())visit(path);else if(entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(ref.sessionId))files.push(path);}};
  visit(history); assert.ok(files.length>=1 && files.length<=3,"Expected a bounded exact-session native history inventory");
  for (const path of files) {
    // Filename matches alone must never authorize moving another project's
    // transcript. Inspect only these exact candidate records, without logging
    // provider messages or any unrelated history.
    const entries = readFileSync(path,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line));
    const metadata = provider === "codex"
      ? entries.filter(entry=>entry.type==="session_meta").map(entry=>({id:entry.payload?.id,cwd:entry.payload?.cwd}))
      : entries.filter(entry=>entry.sessionId===ref.sessionId && entry.cwd).map(entry=>({id:entry.sessionId,cwd:entry.cwd}));
    assert.ok(metadata.some(entry=>entry.id===ref.sessionId && realpathSync(entry.cwd)===realpathSync(project)),"Native candidate must contain the exact disposable session and owning project metadata");
    assert.ok(metadata.every(entry=>entry.id===ref.sessionId && (realpathSync(entry.cwd)===realpathSync(project) || realpathSync(entry.cwd).startsWith(`${realpathSync(project)}/`))),"Never quarantine a foreign project or session record");
  }
  const moved=[];const record={provider,scenario,phase:"unavailable-original-native-session",sessionId:ref.sessionId,scope:realpathSync(project),files:[],status:"running"};ledger.push(record);save();
  const restore=()=>{
    const errors=[];
    for(const item of [...moved].reverse()) {
      const entry=record.files.find(file=>file.path===item.original);
      try {
        assert.equal(existsSync(item.original),false,"Never overwrite a recreated native history file");
        renameSync(item.quarantined,item.original);
        entry.restoredDigest=createHash("sha256").update(readFileSync(item.original)).digest("hex");
        assert.equal(entry.restoredDigest,entry.digest,"Restored test history must preserve its exact original bytes");
        entry.status="restored";
      } catch(error) { entry.status="restoration-failed";entry.error=String(error);errors.push(error); }
      save();
    }
    record.restoredAt=new Date().toISOString();save();
    if(errors.length)throw new AggregateError(errors,"Some disposable native sessions require restoration; exact paths are recorded in ledger.json");
  };
  try {
    for(const original of files){const digest=createHash("sha256").update(readFileSync(original)).digest("hex");const quarantined=`${original}.rafi-disposable-unavailable-${randomUUID()}`;record.files.push({path:original,quarantined,digest,status:"planned"});save();renameSync(original,quarantined);moved.push({original,quarantined});record.files.at(-1).status="quarantined";save();}
    const unavailable = await resolveProviderSessionAvailability(ref,probeOptions);record.availability=unavailable.status;record.reason=unavailable.reason;save();
    assert.equal(unavailable.status,"unavailable","Native provider probe must actually fail to find the original session; fresh flag alone is insufficient");
    record.status="pass";save();return restore;
  }catch(error){record.status="fail";record.error=String(error);save();restore();throw error;}
}
async function phase(project, provider, scenario, name, args, limitMs, expectedCodes = [0], interrupt) {
  const remaining = deadline - Date.now(); assert.ok(remaining > 0, "Authorized deadline reached");
  const row = { provider, scenario, phase: name, args, log: join(root, `${provider}-${scenario}-${name}-${ledger.length}.log`), startedAt: new Date().toISOString(), status: "running" };
  ledger.push(row); save(); console.log(`${provider}/${scenario}: ${name}`);
  const fd = openSync(row.log, "w", 0o600);
  const child = spawn(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", fd, fd] });
  let timedOut = false, fault, injected = false, killTimer;
  const watch = interrupt ? setInterval(() => {
    try {
      if (injected) return;
      // First public start may still be initializing its workflow journal.
      // Absence of a run is not an interruption failure before it exists.
      if (!existsSync(join(project,".rafi","recovery.sqlite3"))) return;
      const state = inspect(project);
      if (state.completed.length < 3 || state.completed.length >= ticketCount(scenario)) return;
      const active = state.operations.filter(op => op.kind === "provider-dispatch" && op.status === "in_progress");
      const role = scenario.startsWith("qa") ? "qa" : "builder";
      if (scenario === "boundary" ? active.length > 0 : !active.some(op => op.intent.role === role)) return;
      const completedIds = state.completed.map(t => t.ticket_id);
      if (scenario === "boundary") {
        const currentTicket = state.run.state?.currentTicket;
        if (!completedIds.includes(currentTicket)) return;
        if (state.operations.some(op => op.kind === "build-assignment" && ["planned", "in_progress", "uncertain"].includes(op.status))) return;
      }
      const definitions = loadTickets(resolveTicketPaths(loadTicketsConfig(project), project).tickets).sort((a,b)=>a.order-b.order);
      const currentDefinitions = definitions.filter(ticket => !completedIds.includes(ticket.id));
      if (["graceful", "abrupt"].includes(scenario) && !currentDefinitions.some(ticket => (ticket.likely_files ?? []).some(path => path.startsWith("src/") && existsSync(join(project,path))))) return;
      const completedFeatures = features.filter(feature => definitions.some(ticket => completedIds.includes(ticket.id) && (ticket.likely_files ?? []).includes(`src/${feature}.mjs`)));
      const modules = Object.fromEntries(completedFeatures.map(feature => [feature, readFileSync(join(project, "src", `${feature}.mjs`), "utf8")]));
      const partialModules = Object.fromEntries(features.filter(feature => !completedFeatures.includes(feature)).flatMap(feature => {const path=join(project,"src",`${feature}.mjs`);return existsSync(path)?[[feature,readFileSync(path,"utf8")]]:[];}));
      row.interruption = { at: new Date().toISOString(), runId: state.run.runId, checkpoint: state.run.checkpoint, currentTicket: state.run.state?.currentTicket, assignmentState: state.operations.filter(op => op.kind === "build-assignment"), qaState: state.qa, completedIds, completed: state.completed, qa: state.qa.filter(q => completedIds.includes(q.ticket_id)), assignmentIds: state.operations.filter(op => op.kind === "build-assignment" && completedIds.includes(op.intent.ticketId)).map(op => op.idempotencyKey), modules, partialModules, branch: execFileSync("git", ["branch", "--show-current"], { cwd: project }).toString().trim(), active };
      writeFileSync(join(root, `${provider}-${scenario}-interruption.json`), JSON.stringify(row.interruption, null, 2));
      if (scenario === "abrupt") {
        assert.equal(state.lease?.runId, state.run.runId);
        assert.equal(classifyProcess(state.lease.pid, state.lease.processStart, state.lease.host).state, "live");
        assert.notEqual(state.lease.pid, process.pid);
        row.interruption.signal = "SIGKILL"; row.interruption.pid = state.lease.pid;
        process.kill(state.lease.pid, "SIGKILL");
      } else { row.interruption.signal = "SIGTERM"; row.interruption.pid = child.pid; child.kill("SIGTERM"); }
      injected = true; save();
    } catch (error) { if (error?.message === "No build run") return; fault = error; clearInterval(watch); child.kill("SIGTERM"); }
  }, 75) : undefined;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 45_000); }, Math.min(limitMs, Math.max(1,remaining-60_000)));
  try {
    const code = await new Promise((res, rej) => { child.once("error", rej); child.once("close", res); });
    Object.assign(row, { code, status: !timedOut && !fault && expectedCodes.includes(code) ? injected ? "expected-interruption" : code === 0 ? "pass" : "expected-initial-approval" : "fail", finishedAt: new Date().toISOString() }); save();
    assert.equal(timedOut, false, `Timed out: ${row.log}`); assert.ifError(fault);
    assert.ok(expectedCodes.includes(code), `${name} exited ${code}: ${row.log}`);
    if (interrupt === true) assert.equal(injected, true, "Required interruption after three completed tickets was not exercised");
    return row;
  } finally { clearInterval(watch); clearTimeout(timer); clearTimeout(killTimer); closeSync(fd); }
}
async function finalAssertions(project, provider, scenario, interruption) {
  const count=ticketCount(scenario);
  const state = inspect(project);
  assert.equal(state.run.status, "completed"); assert.equal(state.completed.length, count);
  assert.equal(state.run.state.progress.completedTickets.length, count);
  assert.equal(state.operations.filter(op => op.kind === "provider-dispatch" && ["in_progress", "uncertain"].includes(op.status)).length, 0);
  assert.equal(state.decisions.length, 0); assert.equal(state.readiness.length, 0);
  assert.equal(state.lease, undefined, "Completed build must release execution ownership");
  if (state.admission) assert.equal(classifyProcess(state.admission.pid,state.admission.processStart,state.admission.host).state,"dead","No completed fixture may retain a live or unverifiable admission owner");
  const lastWorker=state.events.filter(event=>event.type==="worker_started").at(-1)?.payload;
  assert.ok(lastWorker?.workerPid,"Final worker identity must be recorded");
  const cleanup={provider,scenario,phase:"final-owned-process-verification",worker:lastWorker,status:"running",startedAt:new Date().toISOString()};ledger.push(cleanup);save();
  const quiescent=()=>classifyProcess(lastWorker.workerPid,lastWorker.processStart,lastWorker.host).state==="dead" && processGroupQuiescent(lastWorker.workerPid);
  const cleanupDeadline=Math.min(deadline,Date.now()+10_000);
  let stopped=quiescent();
  while(!stopped && Date.now()<cleanupDeadline){await new Promise(resolve=>setTimeout(resolve,100));stopped=quiescent();}
  cleanup.status=stopped?"pass":"fail";cleanup.finishedAt=new Date().toISOString();save();
  assert.equal(stopped,true,"The exact final worker and owned group must be verified stopped within the bounded cleanup check");
  if (interruption) {
    assert.equal(state.run.runId, interruption.runId, "Resume must continue the same build, never restart");
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: project }).toString().trim(), interruption.branch);
    for (const completed of interruption.completed) assert.equal(state.completed.find(t => t.ticket_id === completed.ticket_id)?.completed_at, completed.completed_at);
    for (const qa of interruption.qa) assert.deepEqual(state.qa.find(q => q.ticket_id === qa.ticket_id), qa, "Accepted QA must remain intact");
    assert.deepEqual(state.operations.filter(op => op.kind === "build-assignment" && interruption.completedIds.includes(op.intent.ticketId)).map(op => op.idempotencyKey), interruption.assignmentIds, "Completed ticket assignments must not replay");
    for (const [feature, bytes] of Object.entries(interruption.modules)) assert.equal(readFileSync(join(project, "src", `${feature}.mjs`), "utf8"), bytes, "Preserved feature implementation changed during resume");
  }
  const checks=["assert.equal(api.subtract(5,2),3);","assert.equal(api.multiply(-3,4),-12);","assert.equal(api.divide(9,2),4.5); assert.throws(()=>api.divide(1,0),RangeError);","assert.equal(api.modulo(-5,3),-2); assert.throws(()=>api.modulo(1,0),RangeError);","assert.equal(api.power(2,4),16);","assert.equal(api.clamp(12,0,10),10); assert.throws(()=>api.clamp(1,3,2),RangeError);","assert.equal(api.sum([]),0); assert.equal(api.sum([2,-3,7]),6);","assert.equal(api.mean([2,4]),3); assert.throws(()=>api.mean([]),RangeError);"];
  const check = `import assert from 'node:assert/strict'; import * as api from './index.mjs'; assert.equal(api.add(2,3),5); ${checks.slice(0,count).join(" ")}`;
  execFileSync(process.execPath, ["--input-type=module", "-e", check], { cwd: project, timeout: 30_000 });
  execFileSync("npm", ["test"], { cwd: project, timeout: 30_000, stdio: "pipe" });
  writeFileSync(join(root, `${provider}-${scenario}-final.json`), JSON.stringify(state, null, 2));
  ledger.push({ provider, scenario, phase: count===8 ? "eight-ticket-independent-acceptance" : "focused-five-ticket-independent-acceptance", status: "pass", runId: state.run.runId, completedIds: state.completed.map(t => t.ticket_id) }); save();
}
async function seedReviewedFocusedFixture(baseline,provider,scenario){
  assert.equal(ledger.some(row=>row.provider===provider && row.scenario===scenario && row.phase==="build-start"),false,"Never seed definitions after a build has started");
  await phase(baseline,provider,"setup","ticket-setup",["tickets","setup:init","--project",baseline,"--defaults","--branch-strategy","current","--completion","none","--population-mode","approved_plan"],60_000);
  const source=liveProjectPath(workspaceRoot,"codex-qa-continuation");
  const ticketPath=resolveTicketPaths(loadTicketsConfig(source),source).tickets;
  const approved=loadTickets(ticketPath).sort((a,b)=>a.order-b.order);
  assert.equal(approved.length,5);
  for(const [index,ticket] of approved.entries())assert.ok(ticket.likely_files.includes(`src/${features[index]}.mjs`),"Only reviewed five-feature definitions may be reused");
  const ticketBytes=readFileSync(ticketPath),planPath=join(source,"docs-rafi","rafi-plan.md");
  const plan=readFileSync(planPath,"utf8").replace(/^<!-- rafi-plan[^\n]*-->\r?\n/,"");
  writeFileSync(resolveTicketPaths(loadTicketsConfig(baseline),baseline).tickets,ticketBytes);
  writeFileSync(join(baseline,"docs-rafi","focused-validation-plan.md"),`# Preplanned focused validation fixture\n\nReviewed planning text reused for this new disposable project; no prior workflow, tracker, provider identity or implementation is copied.\n\n${plan}`);
  ledger.push({provider,scenario,phase:"preplanned-focused-fixture",status:"pass",sourceTicketPath:ticketPath,sourcePlanPath:planPath,ticketDigest:createHash("sha256").update(ticketBytes).digest("hex"),planDigest:createHash("sha256").update(plan).digest("hex"),freshPublicPlanning:false,projectBoundStateCopied:false});save();
}
try {
  for (const provider of providers) for (const scenario of scenarios) {
    const count=ticketCount(scenario), scenarioBrief=count===8?brief:focusedBrief;
    // Recovery databases are project-bound. Each native journey is initialized
    // at its final canonical path; never clone a DB into another project.
    const baseline = liveProjectPath(workspaceRoot, scenario === "consecutive" ? `${provider}-planned` : `${provider}-${scenario}`);
    if(process.env.RAFI_LIVE_ASSERT_ONLY==="1") assert.ok(existsSync(baseline),"Assert-only mode never creates a fixture or starts a provider");
    if (!existsSync(baseline)) {
      mkdirSync(join(baseline, "test"), { recursive: true }); mkdirSync(join(baseline, "src"));
      writeFileSync(join(baseline, "package.json"), JSON.stringify({ name: "rafi-live-eight-ticket-fixture", private: true, type: "module", scripts: { test: "node --test test/*.test.mjs" } }, null, 2));
      writeFileSync(join(baseline, "index.mjs"), "export const add = (a,b) => a+b;\n");
      writeFileSync(join(baseline, "test/add.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {add} from '../index.mjs'; test('add preserved',()=>assert.equal(add(2,3),5));\n");
      writeFileSync(join(baseline, "README.md"), "Disposable private arithmetic fixture. Node built-in tests only; no dependencies/network/remote actions.\n");
      const git = args => execFileSync("git", args, { cwd: baseline, stdio: "pipe" });
      git(["init", "-q", "-b", "main"]); git(["config", "user.email", "rafi-live@example.test"]); git(["config", "user.name", "Disposable Rafi fixture"]); git(["add", "."]); git(["commit", "-qm", "Disposable baseline"]);
      await phase(baseline, provider, "setup", "create", ["create", ".", "--defaults", "--no-graph", "--runtime", provider, "--docs-root", "docs-rafi"], 180_000);
      if (count === 5 && process.env.RAFI_LIVE_REUSE_FOCUSED_PLAN === "1") {
        // These focused recovery fixtures reuse reviewed public definitions,
        // not planning evidence or any project-bound state/implementation.
        await seedReviewedFocusedFixture(baseline,provider,scenario);
      } else {
        await phase(baseline, provider, "setup", "plan", ["plan", ".", "--agent", provider, "--brief", scenarioBrief, "--no-grill-me", "--yes"], 300_000);
        await phase(baseline, provider, "setup", "ticket-setup", ["tickets", "setup:init", "--project", baseline, "--defaults", "--branch-strategy", "current", "--completion", "none"], 60_000);
        await phase(baseline, provider, "setup", "ticket-plan", ["tickets", "plan", "--project", baseline, "--agent", provider, "--brief", scenarioBrief, "--no-grill-me", "--yes"], 360_000);
      }
    }
    let definitions = loadTickets(resolveTicketPaths(loadTicketsConfig(baseline), baseline).tickets);
    if(definitions.length===0 && count===5 && process.env.RAFI_LIVE_REUSE_FOCUSED_PLAN==="1" && process.env.RAFI_LIVE_ASSERT_ONLY!=="1"){
      await seedReviewedFocusedFixture(baseline,provider,scenario);
      definitions=loadTickets(resolveTicketPaths(loadTicketsConfig(baseline),baseline).tickets);
    }
    assert.equal(definitions.length, count, "Public planning must create exactly the approved substantive tickets");
      const project = baseline;
      const prior = existsSync(join(root, `${provider}-${scenario}-interruption.json`)) ? JSON.parse(readFileSync(join(root, `${provider}-${scenario}-interruption.json`), "utf8")) : undefined;
      if(process.env.RAFI_LIVE_ASSERT_ONLY==="1"){await finalAssertions(baseline,provider,scenario,prior);continue;}
      let interruption = prior;
      const existingAttempt = !prior && existsSync(join(project,".rafi","recovery.sqlite3")) && ledger.some(row=>row.provider===provider && row.scenario===scenario && row.phase==="build-start");
      if (existingAttempt) {
        const state=inspect(project);
        assert.ok(["paused","failed","recoverable","blocked"].includes(state.run.status),"Only an existing stopped disposable run can continue this failed lane");
        const work=await phase(project,provider,scenario,"existing-lane-recovery",["resume",".","--run",state.run.runId,"--yes"],2_700_000,[2],true);
        interruption=work.interruption;
      } else if (!prior) {
        const started = await phase(project, provider, scenario, "build-start", ["start", ".", "--agent", provider, "--steps", String(count), "--yes"], 1_800_000, [0, 2], scenario === "consecutive" ? false : "optional");
        if (started.interruption) interruption=started.interruption;
        else if (started.code === 2) {
          const state = inspect(project); assert.equal(state.decisions.length, 1); const decision = state.decisions[0];
          assert.equal(decision.prompt, "How does this plan look?"); assert.ok(decision.choices.some(c => c.id === "proceed"));
          await phase(project, provider, scenario, "initial-approve", ["build:decide", ".", "--run", state.run.runId, "--decision", decision.decisionId, "--choice", "proceed"], 30_000);
          const work = await phase(project, provider, scenario, scenario === "consecutive" ? "consecutive-build" : "interrupted-build", ["resume", ".", "--run", state.run.runId, "--yes"], 2_700_000, scenario === "consecutive" ? [0] : [2], scenario !== "consecutive");
          interruption = work.interruption;
        } else assert.equal(scenario, "consecutive", "Interruption not exercised");
      }
      if (interruption) {
        const paused = inspect(project); assert.equal(paused.run.runId, interruption.runId); assert.ok(["paused", "failed", "recoverable", "blocked"].includes(paused.run.status));
        paused.recoveryChoices = recoverableBuildRuns(project).map(run=>({runId:run.runId,status:run.status,ownership:run.ownership,checkpoint:run.checkpoint,tickets:run.tickets}));
        assert.ok(paused.recoveryChoices.some(run=>run.runId===interruption.runId),"The interrupted build must remain discoverable for recovery");
        writeFileSync(join(root, `${provider}-${scenario}-paused.json`), JSON.stringify(paused, null, 2));
        if (scenario.startsWith("qa-fix") && !ledger.some(row=>row.provider===provider && row.scenario===scenario && row.phase==="deliberate-unfinished-product-defect")) {
          const activeQa=paused.qa.find(head=>!interruption.completedIds.includes(head.ticket_id) && ["turn-intended","turn-uncertain","operator-menu"].includes(head.state));
          assert.ok(activeQa,"The deliberate fault must target an unfinished interrupted QA ticket");
          const ticket=definitions.find(ticket=>ticket.id===activeQa.ticket_id);
          const feature=features.find(feature=>ticket.likely_files?.includes(`src/${feature}.mjs`) && existsSync(join(project,"src",`${feature}.mjs`)));
          assert.ok(feature,"An exact unfinished product module is required for QA fault injection");
          const path=join(project,"src",`${feature}.mjs`), original=readFileSync(path);
          const defective=`export function ${feature}() { throw new Error("Intentional disposable QA recovery defect"); }\n`;
          writeFileSync(path,defective);
          ledger.push({provider,scenario,phase:"deliberate-unfinished-product-defect",status:"injected",ticketId:ticket.id,path,beforeDigest:createHash("sha256").update(original).digest("hex"),injectedDigest:createHash("sha256").update(defective).digest("hex")});save();
        }
        // Abrupt Builder death exercises unavailable original sessions. QA and
        // ticket-boundary interruptions have different predecessor identities.
        const restore = process.env.RAFI_LIVE_UNAVAILABLE_PREDECESSOR === "1" && scenario === "abrupt" ? await quarantineOwnPredecessor(project,provider,scenario,paused) : undefined;
        try { await phase(project, provider, scenario, "same-build-resume", ["resume", ".", "--run", interruption.runId, "--yes", ...(process.env.RAFI_LIVE_FRESH_RESUME === "1" ? ["--fresh-with-handoff"] : [])], 2_700_000); }
        finally { restore?.(); }
      }
      await finalAssertions(project, provider, scenario, interruption);
  }
} catch (error) { ledger.push({ status: "fail", error: String(error), at: new Date().toISOString() }); save(); throw error; }
console.log(`All requested multi-ticket gates passed; evidence ${root}`);
