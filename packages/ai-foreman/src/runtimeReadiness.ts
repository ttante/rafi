import { spawn, type SpawnOptions } from "node:child_process";
import type { RuntimeProbeCategory, RuntimeProbePhase, RuntimeProbeResult } from "rafi-spec";
import type { AgentRuntime } from "./runtimeAuth.js";

export const RUNTIME_PROBE_TIMEOUT_MS = 30_000;
export const RUNTIME_DIAGNOSTIC_LIMIT = 8 * 1024;
const RELEVANT_ENV = /^(ANTHROPIC|CLAUDE|CODEX|OPENAI|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)(_|$)/i;

export interface ProbeRuntimeOptions {
  phase?: RuntimeProbePhase;
  timeoutMs?: number;
  maxDiagnosticsBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export async function probeRuntime(
  cwd: string,
  runtime: AgentRuntime,
  opts: ProbeRuntimeOptions = {},
): Promise<RuntimeProbeResult> {
  const executable = runtime === "claude" ? "claude" : "codex";
  const args = runtime === "claude"
    ? ["-p", "Return exactly OK"]
    : ["exec", "--skip-git-repo-check", "-C", cwd, "Return exactly OK"];
  const phase = opts.phase ?? "readiness";
  const env = opts.env ?? process.env;
  const limit = opts.maxDiagnosticsBytes ?? RUNTIME_DIAGNOSTIC_LIMIT;
  const timeoutMs = opts.timeoutMs ?? RUNTIME_PROBE_TIMEOUT_MS;

  return new Promise((resolveResult) => {
    let output = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    const spawnOpts: SpawnOptions = { cwd, env, stdio: ["ignore", "pipe", "pipe"] };
    const child = spawn(executable, args, spawnOpts);
    const append = (chunk: Buffer | string): void => {
      if (output.length >= limit) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      output = Buffer.concat([output, bytes.subarray(0, Math.max(0, limit - output.length))]);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);
    timer.unref();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: NodeJS.ErrnoException): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const diagnostics = sanitizeDiagnostics(spawnError?.message
        ? `${spawnError.message}\n${output.toString("utf8")}`
        : output.toString("utf8"), limit);
      const category = timedOut
        ? "timeout"
        : spawnError?.code === "ENOENT"
          ? "missing-executable"
          : exitCode === 0
            ? "ready"
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
        diagnostics,
        environmentNames: Object.keys(env).filter((name) => RELEVANT_ENV.test(name)).sort(),
        recoveryChoices: category === "ready" ? [] : ["retry", "switch", "cancel"],
      });
    };
    child.once("error", (error: NodeJS.ErrnoException) => finish(null, null, error));
    child.once("close", (code, signal) => finish(code, signal));
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
      ? "Authenticate with `claude auth login --claudeai`, then retry."
      : "Authenticate with `codex login`, then retry.");
  } else {
    lines.push("Review the diagnostic below, then retry, switch to a verified provider, or cancel.");
  }
  if (result.diagnostics) lines.push("", result.diagnostics);
  return lines.join("\n");
}
