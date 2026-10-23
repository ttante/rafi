import { nativeFixtureTurn } from "../helpers/nativeOutput.js";
import { nativePolicy } from "../../src/structuredOperation.js";
import { workReportOutput } from "rafi-spec";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { WorkflowDb } from "../../src/workflowDb.js";
import { HandoffService } from "../../src/handoffs.js";
import { ContinuityAdapter, baselineContinuityDelta } from "../../src/continuity.js";
import type { ProviderSessionRefV1, ResolvedAgentSettings } from "rafi-spec";
import type { BuilderAdapter, BuilderEvent } from "../../src/adapters/types.js";
const [root, phase] = process.argv.slice(2) as [string, string];
// `process.kill(process.pid)` is delivered only after this synchronous SQLite
// frame returns, which can accidentally commit the exact boundary this fixture
// intends to crash before. A child `kill -9` makes the fault injection
// process-visible before the surrounding method can return.
const kill = (): never => { spawnSync("/bin/kill", ["-9", String(process.pid)]); throw new Error("SIGKILL did not terminate fixture"); };
const delta = baselineContinuityDelta("Implement T001");
const settings: ResolvedAgentSettings = { role: "builder", source: "project", make: "codex", model: "default", reasoning: "default", fast: false, session_strategy: "compact", settings_revision: 1, display_session_cost: false, auto_compact_threshold_percent: 65, compact_maximum: 10 };
class Adapter implements BuilderAdapter {
  readonly agent = "codex" as const;
  ref: ProviderSessionRefV1;
  constructor(id: string, generation: number) { this.ref = { version: 1, provider: "codex", sessionId: id, role: "builder", stream: "builder", generation, cwd: root, configRoot: root, workspaceIdentity: "fixture", source: "observed", createdAt: new Date(0).toISOString(), validatedAt: new Date(0).toISOString() }; }
  sessionId() { return this.ref.sessionId; }
  sessionRef() { return this.ref; }
  adoptSessionRef(ref: ProviderSessionRefV1) { this.ref = ref; }
  async sendTurn(instruction: string, policy?: Parameters<BuilderAdapter["sendTurn"]>[1]) {
    // The strict acceptance protocol deliberately precedes the handoff packet,
    // so acceptance is no longer the first text in the host instruction.
    if (policy?.output?.operation === "work-report") {
      writeFileSync(join(root, "mutation-observed.txt"), "one dispatch\n");
      if (phase === "dispatched") kill();
    }
    const match = /Acknowledge manifestDigest ([a-f0-9]+), generation (\d+)/.exec(instruction);
    const payload = policy?.output?.operation === "handoff-acceptance"
      ? { manifestDigest: match![1], generation: Number(match![2]), missingResources: [] }
      : { disposition: "modified", evidence: ["mutation-observed.txt"], coverage: null, graphMaintenance: null };
    return nativeFixtureTurn(policy, this.ref.sessionId, payload, "codex", undefined, delta);
  }
  async *events(): AsyncIterable<BuilderEvent> {}
  async close() { if (phase === "adopting" && this.ref.sessionId === "old") kill(); }
}
const old = new Adapter("old", 2);
const next = new Adapter("successor", 0);
const db = new WorkflowDb(root);
db.ensureRun("run");
db.admitWork({runId:"run",kind:"ticket",ticketId:"T001",definition:{id:"T001"},approvalId:"fixture",scopeRevision:"fixture",provenance:{userTurn:"Implement T001",reason:"Authorized handoff crash fixture"}});
db.publishContinuityCheckpoint({ runId: "run", role: "builder", delta, authoritativeStateRevision: 1, sessionRef: old.ref });
db.claimInitialRoleLease("run", "builder", old.ref);
db.recordBranchResumeSession("run", { ticket: "T001", branch: "feature/unit", base: "main", worktreePath: root, sessionId: "old", sessionRef: old.ref, logPath: "fixture" });
db.close();
const beforeAccept = WorkflowDb.prototype.acceptHandoff;
if (phase === "before-acceptance") WorkflowDb.prototype.acceptHandoff = function(...args) { kill(); return beforeAccept.apply(this, args); };
const hasWorkReceipt = (db: WorkflowDb) => db.continuityEvents("run").some(event => event.kind === "provider_response_received" &&
  (db.operation((event.payload as { dispatchId: string }).dispatchId)?.intent as { operation?: string })?.operation === "work-report");
const beforeEvent = WorkflowDb.prototype.appendContinuityEvent;
if (phase === "receipt-before-commit") WorkflowDb.prototype.appendContinuityEvent = function(...args) {
  const result = beforeEvent.apply(this, args);
  if (args[0].kind === "provider_response_received" && hasWorkReceipt(this)) kill();
  return result;
};
const beforeAtomic = WorkflowDb.prototype.atomic;
if (phase === "completed-before-checkpoint") WorkflowDb.prototype.atomic = function<T>(work: () => T): T {
  const result = beforeAtomic.call(this, work) as T;
  if (hasWorkReceipt(this)) kill();
  return result;
};
const beforeCheckpoint = WorkflowDb.prototype.publishContinuityCheckpoint;
if (phase === "event-before-checkpoint") WorkflowDb.prototype.publishContinuityCheckpoint = function(...args) {
  if (hasWorkReceipt(this)) kill();
  return beforeCheckpoint.apply(this, args);
};
const wrapped = new ContinuityAdapter({ adapter: old, projectDir: root, runId: "run", role: "builder", settings });
await new HandoffService(root).transfer({ runId: "run", role: "builder", reason: "fixture", predecessorSessionId: old.sessionId(), predecessorSessionRef: old.ref, compactionCount: 0, compactMaximum: 10 }, async () => next);
if (phase === "accepted") kill();
await wrapped.adoptValidatedSuccessor(next);
if (phase === "adopted") kill();
await wrapped.sendTurn("Implement T001 once", nativePolicy(workReportOutput));
throw new Error(`fixture failed to reach crash phase ${phase}`);
