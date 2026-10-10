import { formatRuntimeProbeFailure, probeRuntime, RuntimeCleanupError, runtimeCleanupRecoveryHelp, type ProbeRuntimeOptions } from "./runtimeReadiness.js";

export type AgentRuntime = "claude" | "codex";

export interface RuntimeAuthErrorOptions {
  runtime: AgentRuntime;
  context: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  cause?: unknown;
}

export class RuntimeAuthError extends Error {
  readonly runtime: AgentRuntime;
  readonly exitCode?: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly authLikely: boolean;
  readonly cleanupUnverified: boolean;

  constructor(opts: RuntimeAuthErrorOptions) {
    super(formatRuntimeAuthFailure(opts), { cause: opts.cause });
    this.name = "RuntimeAuthError";
    this.runtime = opts.runtime;
    this.exitCode = opts.exitCode;
    this.stdout = opts.stdout ?? "";
    this.stderr = opts.stderr ?? "";
    this.authLikely = isRuntimeAuthFailure(`${this.stderr}\n${this.stdout}`);
    this.cleanupUnverified = opts.cause instanceof RuntimeCleanupError;
  }
}

export async function checkRuntimeReady(projectDir: string, runtime: AgentRuntime, options: ProbeRuntimeOptions = {}) {
  const result = await probeRuntime(projectDir, runtime, options);
  if (!result.ok) throw new RuntimeAuthError({
    runtime,
    context: "readiness check",
    exitCode: result.exitCode,
    stderr: formatRuntimeProbeFailure(result),
  });
  return result;
}

export function normalizeRuntimeErrorText(
  runtime: AgentRuntime,
  text: string,
  exitCode?: number | null,
  context = "builder turn",
): string {
  if (!isRuntimeAuthFailure(text)) return text;
  return formatRuntimeAuthFailure({
    runtime,
    context,
    exitCode,
    stderr: text,
  });
}

export function isRuntimeAuthFailure(output: string): boolean {
  return [
    /\b401\b/i,
    /invalid authentication credentials/i,
    /not logged in/i,
    /login required/i,
    /unauthenticated/i,
    /unauthorized/i,
    /expired[\w\s-]*token/i,
    /token[\w\s-]*expired/i,
    /session expired/i,
    /authentication.*expired/i,
  ].some((pattern) => pattern.test(output));
}

export function runtimeCommandLabel(runtime: AgentRuntime): string {
  return runtime === "claude" ? "claude -p" : "codex exec";
}

export function runtimeRepairCommands(runtime: AgentRuntime): string {
  if (runtime === "claude") {
    return [
      "Authenticate in Claude Code using the login method approved by your organization.",
      "Enterprise users should keep using their organization-provided flow (for example, /login-okta).",
      'claude -p "Return exactly OK"',
    ].join("\n");
  }
  return [
    "codex login",
    'codex exec "Return exactly OK"',
  ].join("\n");
}

export function formatRuntimeAuthFailure(opts: RuntimeAuthErrorOptions): string {
  if (opts.cause instanceof RuntimeCleanupError) return `${opts.cause.message}\n\n${opts.context} is paused before further provider work. This is a process cleanup problem; changing login or provider will not clear it.\n\n${runtimeCleanupRecoveryHelp()}`;
  const output = [opts.stderr, opts.stdout].filter(Boolean).join("\n").trim();
  const exit = opts.exitCode === undefined || opts.exitCode === null ? "unknown" : String(opts.exitCode);
  const authLine = isRuntimeAuthFailure(output)
    ? "The runtime output looks like an authentication failure."
    : "The selected runtime failed; review the actual output below before changing authentication.";
  const details = output ? `\n\nRuntime output:\n${truncateRuntimeOutput(output)}` : "";
  return (
    `${runtimeCommandLabel(opts.runtime)} failed during ${opts.context} (exit code ${exit}).\n\n` +
    `${authLine}\n\n` +
    "Repair and verify:\n" +
    indent(runtimeRepairCommands(opts.runtime)) +
    details
  );
}

function outputToString(value: string | Buffer | undefined): string {
  if (!value) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function truncateRuntimeOutput(output: string): string {
  const max = 2000;
  if (output.length <= max) return output;
  return `${output.slice(0, max).trimEnd()}\n... truncated ...`;
}

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}
