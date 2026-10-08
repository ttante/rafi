import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowDb } from "../../src/workflowDb.js";
import { HandoffService } from "../../src/handoffs.js";
import { ContinuityAdapter, baselineContinuityDelta } from "../../src/continuity.js";
import type { ProviderSessionRefV1, ResolvedAgentSettings } from "rafi-spec";
import type { BuilderAdapter, BuilderEvent } from "../../src/adapters/types.js";
const [root, phase] = process.argv.slice(2) as [string, string];
const kill = (): never => { process.kill(process.pid, "SIGKILL"); throw new Error("SIGKILL did not terminate fixture"); };
const delta = baselineContinuityDelta("Implement T001");
const settings: ResolvedAgentSettings = { role: "builder", source: "project", make: "codex", model: "default", reasoning: "default", fast: false, session_strategy: "compact", settings_revision: 1, display_session_cost: false, auto_compact_threshold_percent: 65, compact_maximum: 10 };
class Adapter implements BuilderAdapter {
  readonly agent = "codex" as const;
  ref: ProviderSessionRefV1;
  constructor(id: string, generation: number) { this.ref = { version: 1, provider: "codex", sessionId: id, role: "builder", stream: "builder", generation, cwd: root, configRoot: root, workspaceIdentity: "fixture", source: "observed", createdAt: new Date(0).toISOString(), validatedAt: new Date(0).toISOString() }; }
  sessionId() { return this.ref.sessionId; }
  sessionRef() { return this.ref; }
  adoptSessionRef(ref: ProviderSessionRefV1) { this.ref = ref; }
  async sendTurn(instruction: string) {
    if (!instruction.startsWith("Accept this validated")) {
      writeFileSync(join(root, "mutation-observed.txt"), "one dispatch\n");
      if (phase === "dispatched") kill();
    }
    return { text: `HANDOFF_ACCEPTED\nRAFI_CONTINUITY_DELTA: ${JSON.stringify(delta)}`, isError: false, numTurns: 1, costUsd: 0 };
  }
  async *events(): AsyncIterable<BuilderEvent> {}
  async close() { if (phase === "adopting" && this.ref.sessionId === "old") kill(); }
}
const old = new Adapter("old", 2);
const next = new Adapter("successor", 0);
const db = new WorkflowDb(root);
db.ensureRun("run");
db.publishContinuityCheckpoint({ runId: "run", role: "builder", delta, authoritativeStateRevision: 1, sessionRef: old.ref });
db.claimInitialRoleLease("run", "builder", old.ref);
db.recordBranchResumeSession("run", { ticket: "T001", branch: "feature/unit", base: "main", worktreePath: root, sessionId: "old", sessionRef: old.ref, logPath: "fixture" });
db.close();
const beforeAccept = WorkflowDb.prototype.acceptHandoff;
if (phase === "before-acceptance") WorkflowDb.prototype.acceptHandoff = function(...args) { kill(); return beforeAccept.apply(this, args); };
const beforeReceipt = WorkflowDb.prototype.updateOperation;
if (phase === "completed-before-checkpoint") WorkflowDb.prototype.updateOperation = function(...args) { const result = beforeReceipt.apply(this, args); if (args[1] === "confirmed") kill(); return result; };
const wrapped = new ContinuityAdapter({ adapter: old, projectDir: root, runId: "run", role: "builder", settings });
await new HandoffService(root).transfer({ runId: "run", role: "builder", reason: "fixture", predecessorSessionId: old.sessionId(), predecessorSessionRef: old.ref, compactionCount: 0, compactMaximum: 10 }, async () => next);
if (phase === "accepted") kill();
await wrapped.adoptValidatedSuccessor(next);
if (phase === "adopted") kill();
await wrapped.sendTurn("Implement T001 once");
throw new Error(`fixture failed to reach crash phase ${phase}`);
