import { maintainBuildAdmission, stopBuildAdmissionHeartbeat, launchDigest, localBuildAuthority } from "./buildAdmission.js";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DurableSupervisor } from "./supervisor.js";
import { WorkflowDb } from "./workflowDb.js";
import type { ResolvedAutonomyPolicy } from "rafi-spec";
import { classifyProcess, processStartIdentity } from "./processIdentity.js";
import { cancelOwnedRuntimeProbes } from "./runtimeReadiness.js";

/** Worker IPC is created by the parent; an environment flag alone cannot bypass supervision. */
export function supervisedRunId(): string | undefined {
  return process.send && process.connected ? process.env.RAFI_BUILD_WORKER_RUN || undefined : undefined;
}

/** Both ordinary and branch starts enter through this process boundary. */
export async function superviseStart(projectDir: string, runId: string, policy: ResolvedAutonomyPolicy, selection?: { steps?: string; stacks?: string; detach?: boolean; launchToken?: string; startArgs?: string[] }): Promise<boolean> {
  const preparation = new WorkflowDb(projectDir);
  const invocationDigest = launchDigest(selection?.startArgs ?? ["start", projectDir]);
  try {
    const environmentToken = process.env.RAFI_BUILD_LAUNCH_TOKEN;
    if (environmentToken && selection?.launchToken && environmentToken !== selection.launchToken) throw new Error("Conflicting build launch contexts");
    const launchToken = environmentToken ?? selection?.launchToken;
    if (launchToken) {
      preparation.claimBuildLaunch(runId, launchToken, supervisedRunId() ? "worker" : "coordinator", invocationDigest);
      delete process.env.RAFI_BUILD_LAUNCH_TOKEN;
    } else preparation.acquireBuildAdmission(runId, policy.supervisorEnabled && process.argv.includes("start") ? "coordinator" : "worker");
    const run = preparation.ensureRun(runId, "build");
    policy = preparation.freezeAutonomyPolicy(runId, policy);
    if (selection?.startArgs && !run.state.runId && !run.state.startArgs) preparation.transition(runId, { checkpoint: run.checkpoint, state: { ...run.state, startArgs: selection.startArgs }, event: "build_preparation_saved" });
  } finally { preparation.close(); }
  maintainBuildAdmission(localBuildAuthority(projectDir)!);
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
    try { db.putSupervisorState(runId, { generation: 0, workerGeneration: 0, checkpointRestarts: 0, runRestarts: 0, ...db.supervisorState(runId), status: "disabled" }); }
    finally { db.close(); }
    return false;
  }
  if (!process.argv.includes("start")) return false;
  const args = [...process.execArgv, ...process.argv.slice(1)];
  if (!args.some(arg => arg === "--steps" || arg === "-s" || arg.startsWith("--steps=")) && selection?.steps) args.push("--steps", selection.steps);
  if (!args.some(arg => arg === "--stacks" || arg.startsWith("--stacks=")) && selection?.stacks) args.push("--stacks", selection.stacks);
  const gate = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./buildLaunchGate.ts" : "./buildLaunchGate.js", import.meta.url));
  const gatedArgs = (token: string) => [...process.execArgv, gate, process.argv[1]!, projectDir, token, ...normalizeNestedLaunchArguments(args.slice(process.execArgv.length + 1), token)];
  if (selection?.detach && !process.env.RAFI_DETACHED_SUPERVISOR_RUN) {
    const directory = join(projectDir, ".rafi", "logs");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `supervisor-${runId}.log`);
    const fd = openSync(path, "a", 0o600);
    const launchDb = new WorkflowDb(projectDir);
    const authority = localBuildAuthority(projectDir)!;
    const launch = launchDb.reserveBuildLaunch(authority, "coordinator", invocationDigest, "registered-v2");
    launchDb.dispatchBuildLaunch(authority, launch.token);
    try {
      const parent = spawn(process.execPath, gatedArgs(launch.token), { cwd: process.cwd(), detached: true,
        env: { ...process.env, RAFI_DETACHED_SUPERVISOR_RUN: runId, RAFI_BUILD_LAUNCH_TOKEN: launch.token }, stdio: ["ignore", fd, fd, "ipc"] });
      try { await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { parent.kill("SIGTERM"); reject(new Error("Detached supervisor startup timed out; use rafi resume to reconcile")); }, 15_000);
        parent.once("message", () => {
          try { launchDb.acknowledgeBuildLaunchChild(authority, launch.token, parent.pid!); parent.send("rafi-launch-ack", error => { clearTimeout(timer); if (error) reject(error); else resolve(); }); }
          catch (error) { clearTimeout(timer); parent.kill("SIGTERM"); reject(error); }
        });
        parent.once("error", error => { clearTimeout(timer); if (!parent.pid) launchDb.failBuildLaunch(authority, launch.token); reject(error); });
        parent.once("exit", () => { clearTimeout(timer); launchDb.reconcileBuildLaunches(runId, authority); reject(new Error("Detached supervisor exited during startup; use rafi resume")); });
      }); } finally {
        // Startup rejection can be followed by a late exit/error. Remove DB
        // callbacks before the outer finally closes the connection in either case.
        parent.removeAllListeners("exit");
        parent.removeAllListeners("message");
        parent.removeAllListeners("error");
        parent.on("error", () => {});
        parent.unref();
      }
      console.log(`rafi: launched supervisor for ${runId}; output: ${path}`);
    } finally { launchDb.close(); closeSync(fd); }
    return true;
  }
  const db = new WorkflowDb(projectDir);
  db.ensureRun(runId, "build");
  db.freezeAutonomyPolicy(runId, policy);
  let exitCode = 2;
  let stopRequestSource: string | undefined;
  const supervisor = new DurableSupervisor({ projectDir, runId, policy, admission: localBuildAuthority(projectDir),
    checkpoint: () => db.getRun(runId)?.checkpoint ?? "preparing",
    spawnWorker: generation => {
      let authority = localBuildAuthority(projectDir)!;
      if (db.buildAdmission()?.token !== authority.token) {
        authority = db.reacquireBuildCoordinator(runId);
      }
      const launch = db.reserveBuildLaunch(authority, "worker", invocationDigest, "registered-v2");
      db.dispatchBuildLaunch(authority, launch.token);
      const child = spawn(process.execPath, gatedArgs(launch.token), {
        cwd: process.cwd(), env: { ...process.env, RAFI_BUILD_WORKER_RUN: runId, RAFI_BUILD_WORKER_GENERATION: String(generation), RAFI_BUILD_LAUNCH_TOKEN: launch.token },
        stdio: ["inherit", "inherit", "inherit", "ipc"], detached: process.platform !== "win32",
      });
      const startup = setTimeout(() => child.kill("SIGTERM"), 15_000);
      child.on("message", message => {
        if (!message || typeof message !== "object" || !("kind" in message) || message.kind !== "rafi-launch-registered") return;
        try { db.acknowledgeBuildLaunchChild(authority, launch.token, child.pid!); child.send("rafi-launch-ack", () => {}); clearTimeout(startup); }
        catch { child.kill("SIGTERM"); }
      });
      child.once("exit", () => clearTimeout(startup));
      child.once("error", () => clearTimeout(startup));
      let lastHeartbeat = Date.now();
      let stopping = false;
      const readinessChildren = new Map<number, string>();
      const readinessTags = new Map<number, string>();
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        killTimer = setTimeout(() => { try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL"); } catch { /* exited */ } }, policy.runtimeDeadlines?.shutdown_ms ?? 10_000);
        killTimer.unref();
        try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGTERM"); } catch { /* exited */ }
      };
      const watchdog = setInterval(() => { if (Date.now() - lastHeartbeat > 120_000) { stopRequestSource = "heartbeat-timeout"; stop(); } }, 5_000);
      watchdog.unref();
      child.on("message", message => { if (message && typeof message === "object" && "kind" in message && message.kind === "rafi-worker-heartbeat") lastHeartbeat = Date.now(); });
      child.on("message", message => {
        if (!message || typeof message !== "object" || !("kind" in message) || message.kind !== "rafi-readiness-child") return;
        const value = message as { pid?: unknown; active?: unknown; processStart?: unknown; tag?: unknown };
        if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 1) return;
        if (typeof value.tag === "string") readinessTags.set(Number(value.pid), value.tag);
        if (value.active === false) { readinessChildren.delete(Number(value.pid)); readinessTags.delete(Number(value.pid)); }
        else if (typeof value.processStart === "string") readinessChildren.set(Number(value.pid), value.processStart);
      });
      const result = new Promise<import("./supervisor.js").WorkerOutcome>(resolve => {
        child.once("error", error => {
          clearInterval(watchdog);
          if (child.pid) { stop(); return; } // exit handler owns cleanup and settlement
          db.failBuildLaunch(authority, launch.token);
          resolve({ kind: "failed", detail: error.message });
        });
        child.once("exit", async (code, signal) => {
          clearInterval(watchdog);
          if (killTimer) clearTimeout(killTimer);
          exitCode = code ?? 2;
          try {
          const exitState = db.getRun(runId);
          if (exitState) db.transitionSupervisor(runId, generation, { checkpoint: exitState.checkpoint, event: "worker_exit", payload: { code, signal, stopRequested: stopping, source: stopRequestSource ?? "unknown", at: new Date().toISOString(), generation } });
          // Durable records are authoritative even when the worker never sent IPC.
          const deadline = Date.now() + 5000;
          const owned = db.readinessProcesses(runId).filter(row => {
            const launchChild = db.buildLaunch(launch.token)?.claimant;
            return launchChild && row.owner === launchChild.token;
          });
          const readinessWasActive = owned.length > 0;
          const readinessCleanup = owned.length ? await db.reconcileReadiness(runId, undefined, deadline) : [];
          const readinessQuiescent = readinessCleanup.length === 0;
          if (!readinessQuiescent) {
            exitCode = 2;
            resolve({ kind: "waiting_for_human" });
            console.error(`rafi: readiness cleanup remains unresolved; use rafi resume (${readinessCleanup.join(", ")})`);
            return;
          }
          const launchOutcome = db.reconcileBuildLaunches(runId, authority);
          if (launchOutcome === "retired" && db.buildLaunch(launch.token)?.state === "failed") {
            resolve({ kind: "crashed", detail: "Worker exited before claiming its launch; authorization retired safely" }); return;
          }
          if (signal || stopping) {
            try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL"); } catch { /* owned group exited */ }
            const workerQuiescent = await ownedGroupIsQuiescent(child.pid!);
            const preparationReconciled = canRestartPreparation(db, runId);
            if (!stopping && readinessQuiescent && workerQuiescent && preparationReconciled) {
              db.transitionSupervisor(runId, generation, { status: "paused", checkpoint: "preparation-reconciled", event: "worker_preparation_reconciled", payload: { generation, signal, noImplementationAuthority: true } });
              resolve({ kind: "crashed", detail: "Preparation worker exited before acquiring implementation authority; owned process group is quiescent" });
              return;
            }
            // Process death does not establish that remote side effects stopped.
            // Never replay an unacknowledged provider action automatically.
            const uncertain = [...db.unresolvedRoleDispatches(runId, "builder"), ...db.unresolvedRoleDispatches(runId, "qa")];
            db.transitionSupervisor(runId, generation, { status: "paused", checkpoint: uncertain.length ? "uncertain-worker-dispatch" : "worker-interrupted", event: "worker_reconciliation_required", payload: { generation, signal, uncertainDispatches: uncertain.map(item => item.idempotencyKey), readinessWasActive, readinessQuiescent, workerQuiescent, preparationReconciled, readinessCleanup, readinessOwnershipVerified: [...readinessChildren.values()].every(value => value !== "unavailable") } });
            resolve({ kind: "waiting_for_human" });
          } else {
            const state = db.getRun(runId);
            if (code === 0 && state?.status === "cancelled") { resolve({ kind: "completed" }); }
            else if (code === 0 && state?.status !== "completed") { exitCode = 2; resolve({ kind: "waiting_for_human" }); }
            else resolve(code === 0 ? { kind: "completed" } : code === 2 ? { kind: "waiting_for_human" } : { kind: "failed", detail: `worker exited ${code}` });
          }
          } catch (error) { exitCode = 2; resolve({ kind: "failed", detail: `Worker reconciliation failed: ${String(error)}` }); }
        });
      });
      return { pid: child.pid, result, stop };
    },
  });
  const stopInt = () => { stopRequestSource = "parent-SIGINT"; supervisor.requestStop(); };
  const stopTerm = () => { stopRequestSource = "parent-SIGTERM"; supervisor.requestStop(); };
  process.once("SIGINT", stopInt); process.once("SIGTERM", stopTerm);
  try { await supervisor.run(); }
  finally { process.off("SIGINT", stopInt); process.off("SIGTERM", stopTerm); db.close(); }
  process.exitCode = exitCode;
  return true;
}

/** Deliberately narrow: established work requires the normal recovery flow. */
export function canRestartPreparation(db: WorkflowDb, runId: string): boolean {
  const run = db.getRun(runId);
  return Boolean(run && ["durable-baseline", "preparing", "preparation-reconciled"].includes(run.checkpoint) && db.preparationEligibility(runId).eligible);
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

/** Cleanup cannot hide the original failure or erase an uncertain launch. */
export function finishStartAdmission(projectDir: string, runId: string): void {
  const authority = localBuildAuthority(projectDir);
  if (!authority || authority.runId !== runId) return;
  stopBuildAdmissionHeartbeat(authority);
  const db = new WorkflowDb(projectDir);
  try {
    if (db.buildAdmission()?.token === authority.token) {
      try { db.releaseBuildAdmission(authority); }
      catch (error) { console.error(`rafi: retaining build ownership for reconciliation: ${String(error)}`); }
    }
  } finally { db.close(); }
}

/** Re-exec inherits run selection, but transfers only the newly reserved capability. */
export function normalizeNestedLaunchArguments(args: readonly string[], token: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--launch-token") { i++; continue; }
    if (args[i]!.startsWith("--launch-token=")) continue;
    result.push(args[i]!);
  }
  // Ordinary supervised start gets its run from the acknowledged IPC gate.
  if (result.some(arg => arg === "--preparation-run" || arg === "--recover-run" || arg.startsWith("--preparation-run=") || arg.startsWith("--recover-run="))) result.push("--launch-token", token);
  return result;
}
