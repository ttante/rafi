import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BranchPlanNode,
  GitHubFailure,
  GitHubFailureCode,
  GitHubOperationResult,
  PrResult,
  ReviewMergeStatus,
  MergeMethod,
} from "./types.js";
import { branchNodeFooter } from "./presentation.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 2_000;

interface CommandResult {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  output: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  errorCode?: string;
  errorMessage?: string;
  timedOut: boolean;
}

export function preflightGlab(cwd: string): GitHubOperationResult {
  const version = runCommand(cwd, "glab", ["--version"], 5_000);
  if (!version.ok) {
    return failure("glab_missing", "GitLab CLI is not installed or is not on PATH.", [
      "Install GitLab CLI: https://gitlab.com/gitlab-org/cli",
      "glab --version",
    ], version);
  }
  const remote = runCommand(cwd, "git", ["remote", "get-url", "origin"]);
  if (!remote.ok) {
    return failure("remote_missing", "git remote origin is not configured.", [
      "git remote add origin <gitlab repo url>",
      "git remote get-url origin",
    ], remote);
  }
  if (!looksGitLab(remote.stdout)) {
    return failure("remote_not_gitlab", `origin does not look like a GitLab remote: ${remote.stdout}`, [
      "git remote set-url origin <gitlab repo url>",
      "git remote get-url origin",
    ], remote);
  }
  const auth = runCommand(cwd, "glab", ["auth", "status"], 10_000);
  if (!auth.ok) {
    return classifyCommandFailure(auth, "glab_not_authenticated", "GitLab CLI is not authenticated.", [
      "glab auth login",
      "glab auth status",
    ]);
  }
  return { ok: true, output: version.stdout };
}

export function pushBranchForMr(cwd: string, branch: string): GitHubOperationResult {
  const result = runCommand(cwd, "git", ["push", "-u", "origin", branch], 30_000);
  if (result.ok) return { ok: true, output: result.stdout };
  return classifyCommandFailure(result, "push_failed", [
    `Failed to push branch ${branch} to origin.`,
    "Branch push requires write access and working Git credentials for the remote.",
  ].join(" "), [
    `git push -u origin ${branch}`,
    "git ls-remote origin",
  ]);
}

export interface CreateMrOptions {
  node: BranchPlanNode;
  ready: boolean;
  runId: string;
  qaEvidence?: string;
  commit?: string;
  autoMerge?: boolean;
  cleanup?: boolean;
  mergeMethod?: MergeMethod;
}

export function createOrReuseMr(cwd: string, opts: CreateMrOptions): PrResult {
  const existing = findExistingMr(cwd, opts.node.branch);
  if (!existing.ok) return prFailure(existing);
  if (existing.url) return { status: "existing", url: existing.url };

  const bodyPath = join(cwd, ".foreman", "mr-bodies", opts.runId, `${opts.node.ticket.id}.md`);
  try {
    mkdirSync(join(cwd, ".foreman", "mr-bodies", opts.runId), { recursive: true });
    writeFileSync(bodyPath, buildMrBody(opts), "utf8");
  } catch (err) {
    return prFailure(failure("mr_create_failed", `Failed to write GitLab MR body file at ${bodyPath}.`, [
      `mkdir -p ${shellQuote(join(".foreman", "mr-bodies", opts.runId))}`,
    ], undefined, err instanceof Error ? err.message : String(err)));
  }

  const args = [
    "mr",
    "create",
    "--source-branch",
    opts.node.branch,
    "--target-branch",
    opts.node.baseBranch,
    "--title",
    `${opts.node.ticket.id}: ${opts.node.ticket.title}`,
    "--description",
    readBodyArg(bodyPath),
    "--yes",
  ];
  if (!opts.ready) args.push("--draft");
  if (opts.autoMerge) args.push("--auto-merge");
  if (opts.mergeMethod === "squash") args.push("--squash-before-merge");
  if (opts.cleanup) args.push("--remove-source-branch");

  const created = runCommand(cwd, "glab", args);
  if (created.ok) return { status: "created", url: created.stdout };
  return prFailure(classifyCommandFailure(created, "mr_create_failed", `Failed to create GitLab MR. Branch: ${opts.node.branch}`, [
    `glab mr create --source-branch ${opts.node.branch} --target-branch ${opts.node.baseBranch}`,
    "glab auth status",
  ]));
}

export function enableGitLabAutoMerge(cwd: string, branch: string, cleanup: boolean, method: MergeMethod = "squash"): PrResult {
  const args = ["mr", "merge", branch, "--auto-merge", "--yes"];
  if (method === "squash") args.push("--squash");
  if (method === "rebase") args.push("--rebase");
  if (cleanup) args.push("--remove-source-branch");
  const result = runCommand(cwd, "glab", args, 30_000);
  if (result.ok) return { status: "auto_merge_enabled", url: result.stdout };
  return prFailure(classifyCommandFailure(result, "mr_create_failed", `Failed to enable GitLab MR auto-merge. Branch: ${branch}`, [
    `glab mr merge ${branch} --auto-merge${method === "squash" ? " --squash" : method === "rebase" ? " --rebase" : ""} --yes`,
    "glab auth status",
  ]));
}

export function checkGitLabMrMerged(cwd: string, branch: string): ReviewMergeStatus {
  const result = runCommand(cwd, "glab", [
    "mr",
    "view",
    branch,
    "--output",
    "json",
  ]);
  if (!result.ok) {
    return classifyCommandFailure(result, "mr_create_failed", `Failed to check GitLab MR merge state. Branch: ${branch}`, [
      `glab mr view ${branch} --output json`,
      "glab auth status",
    ]);
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      state?: string;
      web_url?: string;
      webUrl?: string;
      merged_at?: string | null;
      mergedAt?: string | null;
    };
    const state = parsed.state;
    return {
      ok: true,
      merged: state === "merged" || state === "merged_results" || Boolean(parsed.merged_at ?? parsed.mergedAt),
      state,
      url: parsed.web_url ?? parsed.webUrl,
    };
  } catch {
    return {
      ok: true,
      merged: /merged/i.test(result.stdout),
      state: result.stdout.slice(0, 120),
    };
  }
}

function findExistingMr(cwd: string, branch: string): { ok: true; url?: string } | GitHubFailure {
  const result = runCommand(cwd, "glab", [
    "mr",
    "list",
    "--source-branch",
    branch,
    "--output",
    "json",
  ]);
  if (!result.ok) {
    return classifyCommandFailure(result, "mr_create_failed", "Failed to check for an existing GitLab MR.", [
      `glab mr list --source-branch ${branch}`,
      "glab auth status",
    ]);
  }
  try {
    const parsed = JSON.parse(result.stdout) as Array<{ web_url?: string; webUrl?: string }>;
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    return { ok: true, url: first?.web_url ?? first?.webUrl };
  } catch {
    return { ok: true, url: undefined };
  }
}

function runCommand(cwd: string, bin: string, args: string[], timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): CommandResult {
  const result = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: commandTimeoutMs(timeoutMs),
  });
  const stdout = outputToString(result.stdout).trim();
  const stderr = outputToString(result.stderr).trim();
  const output = truncateOutput([stderr, stdout].filter(Boolean).join("\n").trim());
  const error = result.error as NodeJS.ErrnoException | undefined;
  return {
    ok: !error && result.status === 0,
    command: commandDisplay(bin, args),
    stdout,
    stderr,
    output,
    status: result.status,
    signal: result.signal,
    errorCode: error?.code,
    errorMessage: error?.message,
    timedOut: error?.code === "ETIMEDOUT" || result.signal === "SIGTERM",
  };
}

function commandTimeoutMs(defaultMs: number): number {
  const raw = process.env.RAFI_GITLAB_COMMAND_TIMEOUT_MS;
  if (!raw) return defaultMs;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultMs;
}

function classifyCommandFailure(
  result: CommandResult,
  fallbackCode: GitHubFailureCode,
  fallbackMessage: string,
  repairCommands: string[],
): GitHubFailure {
  if (result.errorCode === "ENOENT") {
    return failure("glab_missing", "GitLab CLI is not installed or is not on PATH.", [
      "Install GitLab CLI: https://gitlab.com/gitlab-org/cli",
      "glab --version",
    ], result);
  }
  if (result.timedOut || looksNetworkLike(result.output) || looksNetworkLike(result.errorMessage ?? "")) {
    return failure("network_or_timeout", `${fallbackMessage} The command timed out or hit a network error.`, repairCommands, result);
  }
  if (looksUnauthenticated(result.output)) {
    return failure("glab_not_authenticated", fallbackMessage, repairCommands, result);
  }
  return failure(fallbackCode, fallbackMessage, repairCommands, result);
}

function failure(
  code: GitHubFailureCode,
  message: string,
  repairCommands: string[],
  result?: CommandResult,
  outputOverride?: string,
): GitHubFailure {
  return {
    ok: false,
    code,
    message,
    repairCommands,
    command: result?.command,
    output: outputOverride ?? (result?.output || result?.errorMessage ? truncateOutput([result?.output, result?.errorMessage].filter(Boolean).join("\n")) : undefined),
  };
}

function prFailure(failure: GitHubFailure): PrResult {
  return {
    status: "failed",
    error: failure.message,
    code: failure.code,
    message: failure.message,
    repairCommands: failure.repairCommands,
    command: failure.command,
    output: failure.output,
  };
}

function looksGitLab(remote: string): boolean {
  return /gitlab\./i.test(remote) || /gitlab\.com/i.test(remote);
}

function looksUnauthenticated(output: string): boolean {
  return [
    /not logged in/i,
    /authentication required/i,
    /could not authenticate/i,
    /unauthorized/i,
    /\b401\b/,
  ].some((pattern) => pattern.test(output));
}

function looksNetworkLike(output: string): boolean {
  return [
    /timed? out/i,
    /could not resolve host/i,
    /failed to connect/i,
    /connection (?:reset|refused|closed)/i,
    /\b(?:ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b/i,
  ].some((pattern) => pattern.test(output));
}

function readBodyArg(bodyPath: string): string {
  return readFileSync(bodyPath, "utf8");
}

function buildMrBody(opts: CreateMrOptions): string {
  const ticket = opts.node.ticket;
  return [
    `## ${ticket.id}: ${ticket.title}`,
    "",
    ticket.summary,
    "",
    "## Acceptance Criteria",
    ...ticket.acceptance.map((item) => `- ${item}`),
    "",
    "## Validation",
    opts.qaEvidence ?? "Foreman QA emitted qa_pass.",
    "",
    "## Branch Metadata",
    `- Base: ${opts.node.baseBranch}`,
    `- Head: ${opts.node.branch}`,
    `- Dependencies: ${opts.node.dependencies.length ? opts.node.dependencies.join(", ") : "None"}`,
    `- Commit: ${opts.commit ?? "N/A"}`,
    "",
    branchNodeFooter(opts.node),
    "",
  ].join("\n");
}

function commandDisplay(bin: string, args: string[]): string {
  return [bin, ...args.map(shellQuote)].join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function outputToString(value: string | Buffer | undefined): string {
  if (!value) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function truncateOutput(output: string): string {
  if (output.length <= OUTPUT_LIMIT) return output;
  return `${output.slice(0, OUTPUT_LIMIT).trimEnd()}\n... truncated ...`;
}
