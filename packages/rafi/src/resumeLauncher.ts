import { WorkflowDb } from "ai-foreman/workflow-db.js";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export class ResumeSpawnError extends Error {
  readonly code?: string;
  constructor(cause: NodeJS.ErrnoException) { super(cause.message, { cause }); this.name = "ResumeSpawnError"; this.code = cause.code; }
}

/** Keep the event loop available for ownership maintenance while retaining terminal I/O. */
export interface ResumeLaunchResult { exitCode: number; launchToken: string; childPid?: number; registered: boolean; claimed: boolean }
export function resumeExitCode(result: number | ResumeLaunchResult): number { return typeof result === "number" ? result : result.exitCode; }
export interface ResumeLaunchContext { authority: NonNullable<ReturnType<WorkflowDb["buildAdmission"]>> }
export function launchResumeStart(entry: string, args: string[]): Promise<number>;
export function launchResumeStart(entry: string, args: string[], context: ResumeLaunchContext | undefined): Promise<number | ResumeLaunchResult>;
export async function launchResumeStart(entry: string, args: string[], context?: ResumeLaunchContext): Promise<number | ResumeLaunchResult> {
  const tokenIndex = args.indexOf("--launch-token");
  const token = tokenIndex >= 0 ? args[tokenIndex + 1] : undefined;
  const owner = context?.authority;
  let gated = false;
  if (token) { const db = new WorkflowDb(args[1]!); try { gated = db.buildLaunch(token)?.protocol === "registered-v2"; } finally { db.close(); } }
  if (gated && !owner) throw new Error("Resume launch requires original launcher authority");
  let child: ReturnType<typeof spawn>;
  try {
    const gate = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./resumeLaunchGate.ts" : "./resumeLaunchGate.js", import.meta.url));
    child = spawn(process.execPath, [...process.execArgv, ...(gated ? [gate, entry, args[1]!, token!, ...args] : [entry, ...args])], { stdio: gated ? ["inherit", "inherit", "inherit", "ipc"] : "inherit" });
  }
  catch (error) { throw new ResumeSpawnError(error as NodeJS.ErrnoException); }
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  if (gated) {
    startupTimer = setTimeout(() => child.kill("SIGTERM"), 15_000);
    child.on("message", value => {
      if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== "rafi-launch-registered") return;
      const db = new WorkflowDb(args[1]!);
      try { db.acknowledgeBuildLaunchChild(owner!, token!, child.pid!); child.send("rafi-launch-ack"); clearTimeout(startupTimer); }
      catch { child.kill("SIGTERM"); }
      finally { db.close(); }
    });
  }
  const forwardInt = () => { child.kill("SIGINT"); };
  const forwardTerm = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", forwardInt);
  process.on("SIGTERM", forwardTerm);
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", error => reject(child.pid ? error : new ResumeSpawnError(error)));
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
    });
    if (!gated) return exitCode;
    const state = new WorkflowDb(args[1]!);
    try {
      const launch = state.buildLaunch(token!);
      return { exitCode, launchToken: token!, childPid: child.pid, registered: Boolean(launch?.child), claimed: launch?.state === "claimed" };
    } finally { state.close(); }
  } finally {
    clearTimeout(startupTimer);
    process.off("SIGINT", forwardInt);
    process.off("SIGTERM", forwardTerm);
  }
}
