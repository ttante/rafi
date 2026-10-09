import { fileURLToPath } from "node:url";
import { cleanupReadiness, type ReadinessProcess } from "./readinessCleanup.js";
import { windowsProbeCommand, windowsProbeJobState } from "./windowsProbeJob.js";
import { randomUUID } from "node:crypto";
import { BuildOwnershipError, canonicalProject, type BuildAdmission } from "./buildAdmission.js";
import { WorkflowDb } from "./workflowDb.js";
import { spawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import type { RuntimeProbeCategory, RuntimeProbePhase, RuntimeProbeResult } from "rafi-spec";
import type { AgentRuntime } from "./runtimeAuth.js";
import { currentActivity, withActivityPhase } from "./activity.js";
import { classifyProcess, processGroupQuiescent, taggedProcesses, processStartIdentity } from "./processIdentity.js";

export const RUNTIME_PROBE_TIMEOUT_MS = 120_000;
export const RUNTIME_DIAGNOSTIC_LIMIT = 8 * 1024;
const RELEVANT_ENV = /^(ANTHROPIC|CLAUDE|CODEX|OPENAI|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)(_|$)/i;
const ownedProbes = new Set<() => void>();
const pendingStandaloneCleanup = new Map<string, ReadinessProcess>();

/** Used when a supervised worker loses its parent, including detached probes. */
export function cancelOwnedRuntimeProbes(): void { for (const cancel of ownedProbes) cancel(); }

export interface BuildReadinessContext { project: string; runId: string; authority: BuildAdmission }
export class RuntimeCleanupError extends Error { constructor(message: string) { super(message); this.name = "RuntimeCleanupError"; } }
export interface ProbeRuntimeOptions {
  /** Omit only for standalone authentication/capability commands. Build callers use probeBuildRuntime. */
  build?: BuildReadinessContext;
  phase?: RuntimeProbePhase;
  timeoutMs?: number;
  maxDiagnosticsBytes?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onTrace?: (event: { phase: string; at: string; elapsedMs: number; pid?: number; bytes?: number; exitCode?: number | null; signal?: string | null }) => void;
}

/** Resolve the executable Node will launch without involving a shell. */
export function resolveExecutablePath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (isAbsolute(command) || hasPathSeparator) {
    const candidate = resolve(command);
    return isRunnableFile(candidate, platform) ? candidate : undefined;
  }

  const pathValue = platform === "win32"
    ? env.Path ?? env.PATH ?? env.path
    : env.PATH;
  if (!pathValue) return undefined;

  const extensions = platform === "win32"
    ? executableExtensions(command, env.PATHEXT)
    : [""];
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  for (const entry of pathValue.split(pathDelimiter)) {
    const directory = entry || process.cwd();
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`);
      if (isRunnableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

function executableExtensions(command: string, pathExt: string | undefined): string[] {
  const extensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((value) => value.startsWith(".") ? value : `.${value}`);
  const lower = command.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension.toLowerCase()))
    ? [""]
    : extensions;
}

function isRunnableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function probeBuildRuntime(cwd: string, runtime: AgentRuntime, build: BuildReadinessContext, opts: Omit<ProbeRuntimeOptions, "build"> = {}): Promise<RuntimeProbeResult> {
  if (!build?.authority) throw new BuildOwnershipError("stale-owner", "Build readiness requires original admission authority");
  return probeRuntime(cwd, runtime, { ...opts, build });
}

export async function probeRuntime(
  cwd: string,
  runtime: AgentRuntime,
  opts: ProbeRuntimeOptions = {},
): Promise<RuntimeProbeResult> {
  return withActivityPhase(`checking ${runtime} runtime`, () => probeRuntimeInternal(cwd, runtime, opts));
}

async function probeRuntimeInternal(
  cwd: string,
  runtime: AgentRuntime,
  opts: ProbeRuntimeOptions,
): Promise<RuntimeProbeResult> {
  // Do not overlap a new probe with cleanup that a previous standalone call
  // could not verify. Keep the original identities, never manufacture authority.
  const cleanupDeadline = Date.now() + 5000;
  for (const [id, row] of pendingStandaloneCleanup) {
    const evidence = await cleanupReadiness(row, cleanupDeadline);
    if (evidence.state !== "quiescent") throw new RuntimeCleanupError(`Previous standalone probe cleanup is unverified: ${evidence.reason}. Restore process visibility and retry.`);
    pendingStandaloneCleanup.delete(id);
  }
  const env = opts.env ?? process.env;
  const command = runtime === "claude" ? "claude" : "codex";
  const executable = resolveExecutablePath(command, env) ?? command;
  const args = runtime === "claude"
    ? ["-p", "Return exactly OK"]
    : ["exec", "--skip-git-repo-check", "-C", cwd, "Return exactly OK"];
  const phase = opts.phase ?? "readiness";
  const limit = opts.maxDiagnosticsBytes ?? RUNTIME_DIAGNOSTIC_LIMIT;
  const timeoutMs = opts.timeoutMs ?? RUNTIME_PROBE_TIMEOUT_MS;

  const authority = opts.build?.authority;
  if (opts.build && (!authority || opts.build.runId !== authority.runId || canonicalProject(opts.build.project) !== authority.project)) throw new BuildOwnershipError("stale-owner", "Invalid build readiness owner");
  const ownerProject = opts.build?.project;
  const useHost = Boolean(authority) || process.platform !== "win32";
  const tag = randomUUID();
  let windows: ReturnType<typeof windowsProbeCommand> | undefined;
  if (process.platform === "win32" && !authority) {
    try { windows = windowsProbeCommand(tag, executable, args, cwd, processStartIdentity()); }
    catch (error) { throw new RuntimeCleanupError(`Windows process containment could not initialize: ${String(error)}`); }
  }
  const ownership = ownerProject ? new WorkflowDb(ownerProject) : undefined;
  let ownedProcess: string | undefined;
  try { if (authority && ownership) ownedProcess = ownership.beginOwnedPreparationProcess(authority, tag, true); }
  finally { ownership?.close(); }
  return new Promise((resolveResult, rejectResult) => {
    let output = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    let cancelled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const began = performance.now();
    const trace = (phase: string, data: { pid?: number; bytes?: number; exitCode?: number | null; signal?: string | null } = {}) => {
      try { opts.onTrace?.({ phase, at: new Date().toISOString(), elapsedMs: performance.now() - began, ...data }); } catch { /* non-authoritative diagnostics */ }
    };
    const spawnOpts: SpawnOptions = { cwd: useHost ? process.cwd() : cwd, env: { ...(useHost ? { ...process.env, RAFI_PROBE_ENV: JSON.stringify(env) } : env), RAFI_PROBE_OWNER: tag, ...(windows ? { RAFI_WINDOWS_PROBE_CONFIG: windows.config } : {}) }, stdio: useHost ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" };
    const gate = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./readinessGate.ts" : "./readinessGate.js", import.meta.url));
    const helperNodeArgs = import.meta.url.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [];
    const child = spawn(useHost ? process.execPath : windows?.executable ?? executable, useHost ? [...helperNodeArgs, gate, ownerProject ?? "--standalone", tag, executable, cwd, ...args] : windows?.args ?? args, spawnOpts);
    const childStart = child.pid ? processStartIdentity(child.pid) : undefined;
    let startupError: Error | undefined;
    let providerSpawnError: NodeJS.ErrnoException | undefined;
    let providerResult: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    if (useHost) {
      startupTimer = setTimeout(() => { startupError = new RuntimeCleanupError("Readiness helper startup timed out"); abort(); }, 15_000);
      child.on("message", message => {
        if (!message || typeof message !== "object" || !("kind" in message)) return;
        if (message.kind === "rafi-probe-result") {
          const reported = message as { exitCode?: unknown; signal?: unknown };
          if ((reported.exitCode === null || Number.isInteger(reported.exitCode)) && (reported.signal === null || typeof reported.signal === "string")) {
            providerResult = reported as typeof providerResult;
            setTimeout(() => { if (!settled) { child.stdout?.destroy(); child.stderr?.destroy(); void finish(providerResult!.exitCode, providerResult!.signal); } }, 100).unref();
          }
          return;
        }
        if (message.kind === "rafi-probe-spawn-error") {
          const reported = message as { code?: string; message?: string };
          providerSpawnError = Object.assign(new Error(reported.message ?? "Provider could not start"), { code: reported.code });
          return;
        }
        if (message.kind !== "rafi-probe-registered") return;
        let journal: WorkflowDb | undefined;
        try {
          if (authority && ownedProcess) journal = new WorkflowDb(ownerProject!, undefined, { runId: authority.runId });
          if (cancelled || timedOut || settled) { if (authority && ownedProcess) journal?.revokeReadinessHelper(ownedProcess, authority); child.kill("SIGKILL"); return; }
          if (authority && ownedProcess) journal!.authorizeReadinessHelper(authority, ownedProcess, child.pid!);
          child.send("rafi-probe-authorized", error => { if (error) { startupError = error; abort(); } });
          clearTimeout(startupTimer);
        } catch (error) { startupError = new RuntimeCleanupError(`Readiness authorization failed: ${String(error)}`); abort(); }
        finally { journal?.close(); }
      });
    }
    const notifySupervisor = (active: boolean) => {
      if (process.send && process.connected && process.env.RAFI_BUILD_WORKER_RUN && child.pid) {
        try { process.send({ kind: "rafi-readiness-child", active, tag, pid: child.pid, processStart: active ? processStartIdentity(child.pid) : undefined }, () => {}); } catch { /* Durable ownership survives a disconnected supervisor. */ }
      }
    };
    notifySupervisor(true);
    trace("spawn", { pid: child.pid });
    const append = (chunk: Buffer | string): void => {
      trace("output", { bytes: Buffer.byteLength(chunk) });
      currentActivity()?.pulse(`${runtime} runtime responded`);
      if (output.length >= limit) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      output = Buffer.concat([output, bytes.subarray(0, Math.max(0, limit - output.length))]);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const killOwnedGroup = (signal: NodeJS.Signals) => {
      if (!child.pid || classifyProcess(child.pid, childStart).state !== "live") return;
      try { if (process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch { /* owned process/group already exited */ }
    };
    const stop = () => {
      if (settled || forceTimer) return;
      trace(cancelled ? "cancelled" : "timeout", { pid: child.pid });
      killOwnedGroup("SIGTERM");
      forceTimer = setTimeout(() => {
        killOwnedGroup("SIGKILL");
        child.stdout?.destroy(); child.stderr?.destroy();
        trace("owned-child-cleanup", { pid: child.pid });
        finish(child.exitCode, child.signalCode);
      }, 1_000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    timer.unref();
    const abort = () => { cancelled = true; clearTimeout(timer); stop(); };
    ownedProbes.add(abort);

    const finish = async (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: NodeJS.ErrnoException): Promise<void> => {
      if (settled) return;
      settled = true;
      if (providerResult) { exitCode = providerResult.exitCode; signal = providerResult.signal; }

      clearTimeout(timer);
      // The direct child can close stdio while a descendant that ignored TERM
      // remains alive with redirected pipes. Complete cleanup before dropping
      // the escalation timer; this group was created exclusively for the probe.
      if (timedOut || cancelled) { killOwnedGroup("SIGKILL"); trace("owned-child-cleanup", { pid: child.pid }); }
      clearTimeout(forceTimer);
      opts.signal?.removeEventListener("abort", abort);
      // Probe completion and process cleanup are independent. Clean on success too.
      clearTimeout(startupTimer);
      let cleaned = Boolean(spawnError && !child.pid);
      if (authority && ownedProcess) {
        let journal: WorkflowDb | undefined;
        try {
          journal = new WorkflowDb(ownerProject!, undefined, { runId: authority!.runId });
          const record = journal.readinessProcesses(authority.runId).find(row => row.id === ownedProcess);
          if (record && JSON.parse(record.outcome_json ?? "{}").startup !== "authorized" && !cancelled && !timedOut) startupError ??= new RuntimeCleanupError("Readiness helper exited before authorization");
          const unresolved = await journal.reconcileReadiness(authority.runId, authority);
          cleaned = !unresolved.includes(ownedProcess);
        } catch { cleaned = false; }
        finally { journal?.close(); }
      } else if (child.pid) {
        const row: ReadinessProcess = { id: tag, run_id: "standalone", owner: "standalone", pid: child.pid, process_start: childStart ?? null, host: (await import("node:os")).hostname(), state: "running", outcome_json: JSON.stringify({ protocol: windows ? "windows-job-v1" : "tagged-v2" }) };
        const evidence = await cleanupReadiness(row);
        if (evidence.state !== "quiescent") {
          pendingStandaloneCleanup.set(tag, row);
          // The trusted holder exits on disconnect; retain the record until OS
          // evidence proves it and all supported descendants have stopped.
          if (child.connected) child.disconnect();
        }
        cleaned = evidence.state === "quiescent";
      }
      trace("owned-child-cleanup", { pid: child.pid });
      ownedProbes.delete(abort);
      if (cleaned) notifySupervisor(false);
      trace("settled", { exitCode, signal });
      if (cleaned && authority && ownedProcess) {
        let journal: WorkflowDb | undefined;
        try { journal = new WorkflowDb(ownerProject!, undefined, { runId: authority!.runId }); journal.finishOwnedPreparationProcess(authority, ownedProcess, Boolean(spawnError && !child.pid), { ready: !timedOut && !cancelled && exitCode === 0 && /(?:^|\s)OK(?:\s|$)/.test(output.toString("utf8")), exitCode, timedOut, cancelled });
          cleaned = cleaned && journal.unresolvedPreparationProcesses(authority.runId).length === 0; }
        catch (error) { cleaned = false; trace("ownership-reconciliation-required"); }
        finally { journal?.close(); }
      }
      if (startupError) { rejectResult(new RuntimeCleanupError(`${startupError.message}${cleaned ? "; cleanup verified; retry readiness" : authority ? "; cleanup requires rafi resume" : "; standalone cleanup is unverified; restore process visibility and retry"}`)); return; }
      if (!cleaned) { rejectResult(new RuntimeCleanupError(authority
        ? "Readiness process cleanup is unverified; use rafi resume in the owning project to reconcile before continuing"
        : "Standalone probe cleanup is unverified; restore process visibility and retry. No new probe will start until cleanup is verified.")); return; }
      spawnError ??= providerSpawnError;
      const diagnostics = sanitizeDiagnostics(spawnError?.message
        ? `${spawnError.message}\n${output.toString("utf8")}`
        : output.toString("utf8"), limit);
      const category = cancelled ? "unknown" : timedOut
        ? "timeout"
        : spawnError?.code === "ENOENT"
          ? "missing-executable"
          : exitCode === 0
            ? /(?:^|\s)OK(?:\s|$)/.test(output.toString("utf8")) ? "ready" : "malformed-protocol"
            : classifyRuntimeFailure(diagnostics, phase);
      resolveResult({
        ok: category === "ready",
        runtime,
        phase,
        category,
        executable,
        cwd,
        timedOut,
        exitCode,
        signal,
        diagnostics: cancelled ? `Runtime probe cancelled. ${diagnostics}` : diagnostics,
        environmentNames: Object.keys(env).filter((name) => RELEVANT_ENV.test(name)).sort(),
        recoveryChoices: category === "ready" ? [] : ["retry", "switch", "cancel"],
      });
    };
    child.once("error", (error: NodeJS.ErrnoException) => finish(null, null, error));
    child.once("exit", (code, signal) => {
      trace("exit", { exitCode: code, signal });
      // Inherited pipes cannot keep a finished direct process waiting for the
      // entire provider timeout. Drain buffered output, then clean descendants.
      setTimeout(() => { if (!settled) { child.stdout?.destroy(); child.stderr?.destroy(); void finish(code, signal); } }, 100).unref();
    });
    child.once("close", (code, signal) => { trace("stdio-closed", { exitCode: code, signal }); finish(code, signal); });
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
  });
}

export function classifyRuntimeFailure(text: string, phase: RuntimeProbePhase = "readiness"): RuntimeProbeCategory {
  const value = text.toLowerCase();
  if (/not logged in|login required|unauthenticated|invalid authentication|expired.{0,20}token|token.{0,20}expired|\b401\b/.test(value)) return "authentication";
  if (/forbidden|not authorized|unauthorized|entitlement|permission denied|\b403\b/.test(value)) return "authorization";
  if (/rate.?limit|too many requests|\b429\b|quota exceeded/.test(value)) return "rate-limit";
  if (/enotfound|econnreset|econnrefused|network|dns|socket hang up|timed? out|tls|certificate/.test(value)) return "network";
  if (/cannot find module|module not found|sdk/.test(value)) return "sdk-load";
  if (/malformed|invalid json|protocol|unexpected token/.test(value)) return "malformed-protocol";
  if (/stream|agent turn|agent error/.test(value)) return "agent-stream";
  if (/config|configuration|invalid model|unsupported model/.test(value)) return "configuration";
  if (phase === "compiler-update") return "compiler-update";
  if (phase === "capability-discovery") return "capability-discovery";
  return "unknown";
}

export function classifyClaudeSdkFailure(
  error: string | undefined,
  status: number | null | undefined,
  diagnostics: string,
): RuntimeProbeCategory {
  switch (error) {
    case "authentication_failed": return "authentication";
    case "oauth_org_not_allowed": return "authorization";
    case "rate_limit": return "rate-limit";
    case "model_not_found":
    case "invalid_request":
    case "max_output_tokens": return "configuration";
    case "billing_error": return "authorization";
    case "server_error": return "agent-stream";
  }
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 407) return "network";
  if (status === 429) return "rate-limit";
  if (status !== undefined && status !== null && status >= 500) return "agent-stream";
  return classifyRuntimeFailure(diagnostics, "builder");
}

export function sanitizeDiagnostics(text: string, maxBytes = RUNTIME_DIAGNOSTIC_LIMIT): string {
  const clean = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)\s*[=:]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1<redacted>")
    .replace(/\b(?:sk|rk|ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer <redacted>")
    .replace(/\s+$/g, "")
    .trim();
  const bytes = Buffer.from(clean);
  if (bytes.length <= maxBytes) return clean;
  return `${bytes.subarray(0, Math.max(0, maxBytes - 18)).toString("utf8")}\n... truncated ...`;
}

export function formatRuntimeProbeFailure(result: RuntimeProbeResult): string {
  if (result.ok) return `${result.executable} is ready.`;
  const lines = [
    `${result.executable} failed during ${result.phase} (${result.category}${result.timedOut ? ", timed out" : result.exitCode === null ? "" : `, exit ${result.exitCode}`}).`,
  ];
  if (result.category === "authentication") {
    lines.push(result.runtime === "claude"
      ? "Authenticate with the Claude Code login method approved by your organization, then rerun `claude -p \"Return exactly OK\"`."
      : "Authenticate with `codex login`, then retry.");
  } else {
    lines.push("Review the diagnostic below, then retry, switch to a verified provider, or cancel.");
  }
  if (result.diagnostics) lines.push("", result.diagnostics);
  return lines.join("\n");
}
