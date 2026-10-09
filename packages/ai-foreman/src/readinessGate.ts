/** Trusted bootstrap: registration and durable authorization precede all provider work. */
import { WorkflowDb } from "./workflowDb.js";
import { spawn } from "node:child_process";
import { windowsProbeCommand } from "./windowsProbeJob.js";
import { processStartIdentity } from "./processIdentity.js";

const [project, id, executable, cwd, ...args] = process.argv.slice(2);
if (!project || !id || !executable || !cwd || !process.send || !process.connected) throw new Error("Missing readiness startup channel");
let disconnected = false;
process.once("disconnect", () => { disconnected = true; });
const providerEnv = JSON.parse(process.env.RAFI_PROBE_ENV ?? "{}");
delete process.env.RAFI_PROBE_ENV;
const standalone = project === "--standalone";
const db = standalone ? undefined : new WorkflowDb(project, undefined, { probeId: id });
// Keep the verified group leader until KILL so TERM-resistant group members
// can still be stopped without signalling a group whose identity was lost.
if (process.platform !== "win32") process.on("SIGTERM", () => {});
try {
  db?.registerReadinessHelper(id);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Readiness authorization timed out")), 10_000);
    const disconnect = () => finish(new Error("Readiness owner disconnected"));
    const message = (value: unknown) => { if (value === "rafi-probe-authorized") finish(); };
    function finish(error?: Error) {
      clearTimeout(timer); process.off("message", message); process.off("disconnect", disconnect);
      if (error) reject(error); else resolve();
    }
    process.on("message", message); process.once("disconnect", disconnect);
    process.send!({ kind: "rafi-probe-registered", id });
    if (disconnected) disconnect();
  });
  db?.assertReadinessHelper(id);
  if (disconnected) throw new Error("Readiness owner disconnected before execution");
  const windows = process.platform === "win32" ? windowsProbeCommand(id, executable, args, cwd, processStartIdentity(), true) : undefined;
  const child = spawn(windows?.executable ?? executable, windows?.args ?? args, {
    cwd, env: { ...providerEnv, RAFI_PROBE_OWNER: id, ...(windows ? { RAFI_WINDOWS_PROBE_CONFIG: windows.config } : {}) },
    stdio: [windows ? "pipe" : "ignore", "inherit", "inherit"],
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    process.send?.({ kind: "rafi-probe-spawn-error", code: error.code, message: error.message });
    console.error(error.message); process.exitCode = 127;
  });
  const done = new Promise<void>(resolve => { child.once("exit", (code, signal) => { process.send?.({ kind: "rafi-probe-result", exitCode: code, signal }); process.exitCode = code ?? 1; resolve(); }); child.once("error", () => resolve()); });
  if (windows) {
    try {
      if (!child.pid) throw new Error("Windows job creator did not start");
      db?.recordReadinessCreator(id, child.pid);
      // The creator consumes this only after its identity is durable. EOF is rejection.
      child.stdin!.end("rafi-create-job\n");
    } catch (error) { child.stdin?.destroy(); child.kill(); throw error; }
  }
  const ownerGone = () => { child.kill(); process.exitCode = 125; };
  process.once("disconnect", ownerGone);
  await done;
  process.off("disconnect", ownerGone);
  // Retain the registered group leader until the parent settles cleanup. This
  // lets it signal the verified group even when provider descendants scrub env.
  if (child.pid && !disconnected && process.connected) await new Promise<void>(resolve => process.once("disconnect", resolve));
} finally { db?.close(); if (process.connected) process.disconnect(); }
