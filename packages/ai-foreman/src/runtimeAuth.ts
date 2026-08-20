import { formatRuntimeProbeFailure, probeRuntime } from "./runtimeReadiness.js";

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

  constructor(opts: RuntimeAuthErrorOptions) {
    super(formatRuntimeAuthFailure(opts), { cause: opts.cause });
    this.name = "RuntimeAuthError";
    this.runtime = opts.runtime;
    this.exitCode = opts.exitCode;
    this.stdout = opts.stdout ?? "";
    this.stderr = opts.stderr ?? "";
    this.authLikely = isRuntimeAuthFailure(`${this.stderr}\n${this.stdout}`);
  }
}

export async function checkRuntimeReady(projectDir: string, runtime: AgentRuntime): Promise<void> {
  const result = await probeRuntime(projectDir, runtime);
  if (!result.ok) throw new RuntimeAuthError({
    runtime,
    context: "readiness check",
    exitCode: result.exitCode,
    stderr: formatRuntimeProbeFailure(result),
  });
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
      "claude auth logout",
      "claude auth login --claudeai",
      'claude -p "Return exactly OK"',
      "",
      "Claude subscription users may also need:",
      "claude setup-token",
    ].join("\n");
  }
  return [
    "codex login",
    'codex exec "Return exactly OK"',
  ].join("\n");
}

export function formatRuntimeAuthFailure(opts: RuntimeAuthErrorOptions): string {
  const output = [opts.stderr, opts.stdout].filter(Boolean).join("\n").trim();
  const exit = opts.exitCode === undefined || opts.exitCode === null ? "unknown" : String(opts.exitCode);
  const authLine = isRuntimeAuthFailure(output)
    ? "The runtime output looks like an authentication failure."
    : "This often means the selected agent runtime is missing or not authenticated.";
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
