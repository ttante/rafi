import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DurableSupervisor } from "./supervisor.js";
import { WorkflowDb } from "./workflowDb.js";
import type { ResolvedAutonomyPolicy } from "rafi-spec";
import { processStartIdentity } from "./processIdentity.js";
import { cancelOwnedRuntimeProbes } from "./runtimeReadiness.js";

/** Worker IPC is created by the parent; an environment flag alone cannot bypass supervision. */
export function supervisedRunId(): string | undefined {
  return process.send && process.connected ? process.env.RAFI_BUILD_WORKER_RUN || undefined : undefined;
}

/** Both ordinary and branch starts enter through this process boundary. */
export async function superviseStart(projectDir: string, runId: string, policy: ResolvedAutonomyPolicy, selection?: { steps?: string; stacks?: string; detach?: boolean }): Promise<boolean> {
  if (supervisedRunId()) {
    const heartbeat = setInterval(() => { if (process.connected) process.send?.({ kind: "rafi-worker-heartbeat", runId }); }, 5_000);
    heartbeat.unref();
    process.once("disconnect", () => {
      clearInterval(heartbeat);
      cancelOwnedRuntimeProbes();
      let state: WorkflowDb | undefined;
      try {
        state = new WorkflowDb(projectDir);
        const durable = state;
        durable.atomic(() => {
          const owner = durable.supervisorState(runId);
          if (owner?.workerGeneration !== Number(process.env.RAFI_BUILD_WORKER_GENERATION) || owner.workerPid !== process.pid) return;
          durable.transition(runId, { status: "paused", checkpoint: "orphaned-worker", event: "supervisor_disconnected", payload: { workerPid: process.pid } });
          durable.putSupervisorState(runId, { ...owner, status: "stopping" });
        });
      } catch (error) { console.error(`rafi: could not persist orphaned-worker checkpoint: ${String(error)}`); }
      finally { state?.close(); }
      // A signal handler may only checkpoint. The vanished parent can no longer
      // enforce its kill timer, so this worker must bound its own group cleanup.
      const group = process.platform === "win32" ? process.pid : -process.pid;
      const forced = setTimeout(() => { try { process.kill(group, "SIGKILL"); } catch { process.exit(2); } }, (policy.runtimeDeadlines?.shutdown_ms ?? 10_000) + 5_000);
      forced.unref();
      try { process.kill(group, "SIGTERM"); } catch { process.kill(process.pid, "SIGTERM"); }
    });
    return false;
  }
  // Embedded API callers retain control of their own process. The actual CLI
  // re-executes its exact entry point and arguments, preserving all option sources.
  if (!policy.supervisorEnabled) {
    const db = new WorkflowDb(projectDir);
    try { db.putSupervisorState(runId, { status: "disabled", generation: 0, workerGeneration: 0, checkpointRestarts: 0, runRestarts: 0 }); }
    finally { db.close(); }
    return false;
  }
  if (!process.argv.includes("start")) return false;
  const args = [...process.execArgv, ...process.argv.slice(1)];
  if (!args.some(arg => arg === "--steps" || arg === "-s" || arg.startsWith("--steps=")) && selection?.steps) args.push("--steps", selection.steps);
  if (!args.some(arg => arg === "--stacks" || arg.startsWith("--stacks=")) && selection?.stacks) args.push("--stacks", selection.stacks);
  if (selection?.detach && !process.env.RAFI_DETACHED_SUPERVISOR_RUN) {
    const directory = join(projectDir, ".rafi", "logs");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `supervisor-${runId}.log`);
    const fd = openSync(path, "a", 0o600);
    try {
      const parent = spawn(process.execPath, args, { cwd: process.cwd(), detached: true,
        env: { ...process.env, RAFI_DETACHED_SUPERVISOR_RUN: runId }, stdio: ["ignore", fd, fd] });
      await new Promise<void>((resolve, reject) => { parent.once("spawn", resolve); parent.once("error", reject); });
      parent.unref();
      console.log(`rafi: launched supervisor for ${runId}; output: ${path}`);
    } finally { closeSync(fd); }
    return true;
  }
  const db = new WorkflowDb(projectDir);
  db.ensureRun(runId, "build");
  db.freezeAutonomyPolicy(runId, policy);
  let exitCode = 2;
  const supervisor = new DurableSupervisor({ projectDir, runId, policy,
    checkpoint: () => db.getRun(runId)?.checkpoint ?? "preparing",
    spawnWorker: generation => {
      const child = spawn(process.execPath, args, {
        cwd: process.cwd(), env: { ...process.env, RAFI_BUILD_WORKER_RUN: runId, RAFI_BUILD_WORKER_GENERATION: String(generation) },
        stdio: ["inherit", "inherit", "inherit", "ipc"], detached: process.platform !== "win32",
      });
      let lastHeartbeat = Date.now();
      let stopping = false;
      const readinessChildren = new Map<number, string>();
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        killTimer = setTimeout(() => { try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL"); } catch { /* exited */ } }, policy.runtimeDeadlines?.shutdown_ms ?? 10_000);
        killTimer.unref();
        try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGTERM"); } catch { /* exited */ }
      };
      const watchdog = setInterval(() => { if (Date.now() - lastHeartbeat > 120_000) stop(); }, 5_000);
      watchdog.unref();
      child.on("message", message => { if (message && typeof message === "object" && "kind" in message && message.kind === "rafi-worker-heartbeat") lastHeartbeat = Date.now(); });
      child.on("message", message => {
        if (!message || typeof message !== "object" || !("kind" in message) || message.kind !== "rafi-readiness-child") return;
        const value = message as { pid?: unknown; active?: unknown; processStart?: unknown };
        if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 1) return;
        if (value.active === false) readinessChildren.delete(Number(value.pid));
        else if (typeof value.processStart === "string") readinessChildren.set(Number(value.pid), value.processStart);
      });
      const result = new Promise<import("./supervisor.js").WorkerOutcome>(resolve => {
        child.once("error", error => { clearInterval(watchdog); resolve({ kind: "failed", detail: error.message }); });
        child.once("exit", async (code, signal) => {
          clearInterval(watchdog);
          if (killTimer) clearTimeout(killTimer);
          exitCode = code ?? 2;
          try {
          if (signal || stopping) {
            try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL"); } catch { /* owned group exited */ }
            const readinessWasActive = readinessChildren.size > 0;
            let readinessQuiescent = readinessWasActive;
            const readinessCleanup: string[] = [];
            for (const [pid, identity] of readinessChildren) {
              const cleanup = await stopOwnedReadinessGroup(pid, identity);
              if (cleanup !== "quiescent") { readinessQuiescent = false; readinessCleanup.push(cleanup); }
            }
            const workerQuiescent = await ownedGroupIsQuiescent(child.pid!);
            const preparationReconciled = canRestartPreparation(db, runId);
            if (!stopping && readinessQuiescent && workerQuiescent && preparationReconciled) {
              db.transition(runId, { status: "paused", checkpoint: "preparation-reconciled", event: "worker_preparation_reconciled", payload: { generation, signal, noImplementationAuthority: true } });
              resolve({ kind: "crashed", detail: "Preparation worker exited before acquiring implementation authority; owned process group is quiescent" });
              return;
            }
            // Process death does not establish that remote side effects stopped.
            // Never replay an unacknowledged provider action automatically.
            const uncertain = [...db.unresolvedRoleDispatches(runId, "builder"), ...db.unresolvedRoleDispatches(runId, "qa")];
            db.transition(runId, { status: "paused", checkpoint: uncertain.length ? "uncertain-worker-dispatch" : "worker-interrupted", event: "worker_reconciliation_required", payload: { generation, signal, uncertainDispatches: uncertain.map(item => item.idempotencyKey), readinessWasActive, readinessQuiescent, workerQuiescent, preparationReconciled, readinessCleanup, readinessOwnershipVerified: [...readinessChildren.values()].every(value => value !== "unavailable") } });
            resolve({ kind: "waiting_for_human" });
          } else {
            const state = db.getRun(runId);
            if (code === 0 && state?.status !== "completed") { exitCode = 2; resolve({ kind: "waiting_for_human" }); }
            else resolve(code === 0 ? { kind: "completed" } : code === 2 ? { kind: "waiting_for_human" } : { kind: "failed", detail: `worker exited ${code}` });
          }
          } catch (error) { exitCode = 2; resolve({ kind: "failed", detail: `Worker reconciliation failed: ${String(error)}` }); }
        });
      });
      return { pid: child.pid, result, stop };
    },
  });
  const stop = () => supervisor.requestStop();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await supervisor.run(); }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); db.close(); }
  process.exitCode = exitCode;
  return true;
}

/** Deliberately narrow: established work requires the normal recovery flow. */
export function canRestartPreparation(db: WorkflowDb, runId: string): boolean {
  const run = db.getRun(runId);
  if (!run || !["durable-baseline", "preparing", "preparation-reconciled"].includes(run.checkpoint)) return false;
  if (run.state.version !== undefined || db.pendingHumanDecisions(runId).length || db.operations(runId).length || db.handoffs(runId).length) return false;
  if (db.roleMutationLease(runId, "builder") || db.roleMutationLease(runId, "qa")) return false;
  return db.branchResumeSessions(false).length === 0;
}

async function ownedGroupIsQuiescent(pid: number): Promise<boolean> {
  if (process.platform === "win32") return false; // No group-liveness proof on this platform.
  const until = Date.now() + 5_000;
  do {
    try { process.kill(-pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      // Some hosts deny group signal probes even after the last child exits.
      // A complete process inventory can still prove absence or zombie-only
      // membership; missing inventory remains unknown.
    }
    // An orphan may remain as a zombie until the OS reaps it. kill(0) still
    // sees that PID/group, but a verified zombie cannot execute any work.
    try {
      const inventory = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 1_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
        .split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)).filter(row => row !== null);
      const rows = inventory.filter(row => Number(row[2]) === pid);
      if (inventory.some(row => Number(row[1]) === process.pid) && rows.every(row => row[3]!.startsWith("Z"))) return true;
    } catch { /* Incomplete process visibility is not proof of quiescence. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < until);
  return false;
}

async function stopOwnedReadinessGroup(pid: number, expectedStart: string): Promise<string> {
  if (process.platform === "win32" || expectedStart === "unavailable") return "unverified readiness ownership";
  try {
    process.kill(pid, 0);
    const actual = processStartIdentity(pid);
    if (actual !== expectedStart) return `readiness process identity changed: ${expectedStart} -> ${actual}`;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return `readiness liveness unavailable: ${String(error)}`; }
  try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return `readiness group cleanup unavailable: ${String(error)}`; }
  if (await ownedGroupIsQuiescent(pid)) return "quiescent";
  let state = "unavailable";
  try { state = execFileSync("ps", ["-o", "pid=,ppid=,pgid=,stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* keep unknown */ }
  return `readiness group ${pid} remains active or unverified (${state})`;
}
