import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BranchPlanNode,
  GitHubFailure,
  GitHubFailureCode,
  GitHubOperationResult,
  GitHubReadinessResult,
  GitHubRemote,
  GitHubRemoteResult,
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
  const raw = process.env.RAFI_GITHUB_COMMAND_TIMEOUT_MS;
  if (!raw) return defaultMs;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultMs;
}

export function inspectGitHubRemote(cwd: string): GitHubRemoteResult {
  const remote = runCommand(cwd, "git", ["remote", "get-url", "origin"]);
  if (!remote.ok) {
    return failure("remote_missing", "git remote origin is not configured.", [
      "git remote add origin <github repo url>",
      "git remote get-url origin",
    ], remote);
  }

  return parseGitHubRemote(remote.stdout);
}

export function originLooksLikeGitHub(cwd: string): boolean {
  const remote = inspectGitHubRemote(cwd);
  return remote.ok && remote.remote.likelyGitHub;
}

export function checkGitHubReadiness(cwd: string): GitHubReadinessResult {
  const ghVersion = runCommand(cwd, "gh", ["--version"], 5_000);
  if (!ghVersion.ok) {
    return failure("gh_missing", "GitHub CLI is not installed or is not on PATH.", [
      "Install GitHub CLI: https://cli.github.com/",
      "gh --version",
    ], ghVersion);
  }

  const remote = inspectGitHubRemote(cwd);
  if (!remote.ok) return remote;

  const auth = runCommand(cwd, "gh", ["auth", "status", "--hostname", remote.remote.host], 10_000);
  if (!auth.ok) {
    return classifyCommandFailure(auth, "gh_not_authenticated", authMessage(remote.remote), authRepair(remote.remote));
  }

  const repoView = runCommand(cwd, "gh", [
    "repo",
    "view",
    remote.remote.repoArg,
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  if (!repoView.ok) {
    return classifyCommandFailure(repoView, "repo_unreachable", repoMessage(remote.remote), [
      `gh repo view ${remote.remote.repoArg}`,
      ...authRepair(remote.remote),
    ]);
  }

  const lsRemote = runCommand(cwd, "git", ["ls-remote", "origin"]);
  if (!lsRemote.ok) {
    return classifyCommandFailure(lsRemote, "git_remote_unreachable", [
      "git cannot reach the origin remote. Check SSH/token credentials, VPN, network access, and repository permissions.",
      `Origin: ${remote.remote.remoteUrl}`,
    ].join(" "), [
      "git ls-remote origin",
      "git remote -v",
    ]);
  }

  return { ok: true, remote: remote.remote };
}

export function preflightGh(cwd: string): GitHubReadinessResult {
  return checkGitHubReadiness(cwd);
}

export function pushBranchForPr(cwd: string, branch: string): GitHubOperationResult {
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

interface ExistingPrResult {
  ok: true;
  url?: string;
}

export function findExistingPr(cwd: string, branch: string, remote?: GitHubRemote): ExistingPrResult | GitHubFailure {
  const result = runCommand(cwd, "gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "url",
    "--jq",
    ".[0].url",
  ]);
  if (result.ok) return { ok: true, url: result.stdout || undefined };
  return classifyPrFailure(result, branch, "Failed to check for an existing GitHub PR.", remote);
}

export interface CreatePrOptions {
  node: BranchPlanNode;
  ready: boolean;
  runId: string;
  qaEvidence?: string;
  commit?: string;
}

export function createOrReusePr(cwd: string, opts: CreatePrOptions): PrResult {
  const remote = inspectGitHubRemote(cwd);
  const remoteForRepair = remote.ok ? remote.remote : undefined;
  const existing = findExistingPr(cwd, opts.node.branch, remoteForRepair);
  if (!existing.ok) return prFailure(existing);
  if (existing.url) return { status: "existing", url: existing.url };

  const bodyPath = join(cwd, ".foreman", "pr-bodies", opts.runId, `${opts.node.ticket.id}.md`);
  try {
    mkdirSync(join(cwd, ".foreman", "pr-bodies", opts.runId), { recursive: true });
    writeFileSync(bodyPath, buildPrBody(opts), "utf8");
  } catch (err) {
    return prFailure(prBodyWriteFailure(opts.runId, bodyPath, err));
  }

  const args = [
    "pr",
    "create",
    "--base",
    opts.node.baseBranch,
    "--head",
    opts.node.branch,
    "--title",
    `${opts.node.ticket.id}: ${opts.node.ticket.title}`,
    "--body-file",
    bodyPath,
  ];
  if (!opts.ready) args.push("--draft");

  const created = runCommand(cwd, "gh", args);
  if (created.ok) return { status: "created", url: created.stdout };
  return prFailure(classifyPrFailure(created, opts.node.branch, "Failed to create GitHub PR.", remoteForRepair));
}

export function enableGitHubAutoMerge(cwd: string, branch: string, cleanup: boolean, method: MergeMethod = "squash"): PrResult {
  const args = ["pr", "merge", branch, "--auto", `--${method}`];
  if (cleanup) args.push("--delete-branch");
  const result = runCommand(cwd, "gh", args, 30_000);
  if (result.ok) return { status: "auto_merge_enabled", url: result.stdout };
  return prFailure(classifyPrFailure(result, branch, "Failed to enable GitHub PR auto-merge."));
}

export function checkGitHubPrMerged(cwd: string, branch: string): ReviewMergeStatus {
  const remote = inspectGitHubRemote(cwd);
  const remoteForRepair = remote.ok ? remote.remote : undefined;
  const result = runCommand(cwd, "gh", [
    "pr",
    "view",
    branch,
    "--json",
    "state,url",
    "--jq",
    "[.state, .url] | @tsv",
  ]);
  if (!result.ok) {
    return classifyPrFailure(result, branch, "Failed to check GitHub PR merge state.", remoteForRepair);
  }
  const [state, url] = result.stdout.split(/\t/);
  return {
    ok: true,
    merged: state === "MERGED",
    state,
    url: url || undefined,
  };
}

export function formatGitHubFailure(failure: GitHubFailure): string {
  const lines = [
    `${failure.code}: ${failure.message}`,
    "Repair and verify:",
    ...failure.repairCommands.map((command) => `  ${command}`),
  ];
  if (failure.output) {
    lines.push("", "Command output:", indent(failure.output));
  } else if (failure.command) {
    lines.push("", `Command: ${failure.command}`);
  }
  return lines.join("\n");
}

function parseGitHubRemote(remoteUrl: string): GitHubRemoteResult {
  const parsed = parseRemoteParts(remoteUrl.trim());
  if (!parsed) {
    return failure("remote_not_github", `origin does not look like a GitHub remote: ${remoteUrl}`, [
      "git remote set-url origin <github repo url>",
      "git remote get-url origin",
    ]);
  }

  const repo = parsed.repo.replace(/\.git$/i, "");
  if (!parsed.owner || !repo || isKnownNonGitHubHost(parsed.host)) {
    return failure("remote_not_github", `origin does not look like a GitHub remote: ${remoteUrl}`, [
      "git remote set-url origin <github repo url>",
      "git remote get-url origin",
    ]);
  }

  const likelyGitHub = isLikelyGitHubHost(parsed.host);
  const repoArg = parsed.host === "github.com"
    ? `${parsed.owner}/${repo}`
    : `${parsed.host}/${parsed.owner}/${repo}`;
  return {
    ok: true,
    remote: {
      remoteUrl,
      host: parsed.host,
      owner: parsed.owner,
      repo,
      repoArg,
      likelyGitHub,
    },
  };
}

function parseRemoteParts(remoteUrl: string): { host: string; owner: string; repo: string } | undefined {
  const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):([^/\s]+)\/(.+)$/.exec(remoteUrl);
  if (scpLike) {
    return {
      host: scpLike[1]!.toLowerCase(),
      owner: scpLike[2]!,
      repo: lastPathPart(scpLike[3]!),
    };
  }

  try {
    const url = new URL(remoteUrl);
    if (!url.hostname) return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return undefined;
    return {
      host: url.hostname.toLowerCase(),
      owner: parts[0]!,
      repo: lastPathPart(parts.slice(1).join("/")),
    };
  } catch {
    return undefined;
  }
}

function lastPathPart(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function classifyPrFailure(result: CommandResult, branch: string, message: string, remote?: GitHubRemote): GitHubFailure {
  if (looksUnauthenticated(result.output)) {
    return failure("gh_not_authenticated", "GitHub CLI is not authenticated for PR operations.", prRepair(branch, remote), result);
  }
  return classifyCommandFailure(result, "pr_create_failed", `${message} Branch: ${branch}`, prRepair(branch, remote));
}

function classifyCommandFailure(
  result: CommandResult,
  fallbackCode: GitHubFailureCode,
  fallbackMessage: string,
  repairCommands: string[],
): GitHubFailure {
  if (result.errorCode === "ENOENT") {
    const command = result.command.startsWith("gh ") ? "GitHub CLI" : result.command.split(" ")[0];
    return failure(
      result.command.startsWith("gh ") ? "gh_missing" : "unknown",
      `${command} is not installed or is not on PATH.`,
      result.command.startsWith("gh ")
        ? ["Install GitHub CLI: https://cli.github.com/", "gh --version"]
        : repairCommands,
      result,
    );
  }
  if (looksRemoteNotGitHub(result.output)) {
    return failure("remote_not_github", `${fallbackMessage} The origin host is not a GitHub or GitHub Enterprise host.`, repairCommands, result);
  }
  if (looksGhRepoResolutionFailure(result.output)) {
    return failure("repo_unreachable", fallbackMessage, repairCommands, result);
  }
  if (result.timedOut || looksNetworkLike(result.output) || looksNetworkLike(result.errorMessage ?? "")) {
    return failure("network_or_timeout", `${fallbackMessage} The command timed out or hit a network error.`, repairCommands, result);
  }
  if (fallbackCode === "gh_not_authenticated" || looksUnauthenticated(result.output)) {
    return failure("gh_not_authenticated", fallbackMessage, repairCommands, result);
  }
  return failure(fallbackCode, fallbackMessage, repairCommands, result);
}

function prBodyWriteFailure(runId: string, bodyPath: string, err: unknown): GitHubFailure {
  const bodyDir = join(".foreman", "pr-bodies", runId);
  return {
    ok: false,
    code: "pr_create_failed",
    message: `Failed to write GitHub PR body file at ${bodyPath}.`,
    repairCommands: [
      `ls -la ${shellQuote(join(".foreman", "pr-bodies"))}`,
      `mkdir -p ${shellQuote(bodyDir)}`,
    ],
    output: err instanceof Error ? err.message : String(err),
  };
}

function failure(
  code: GitHubFailureCode,
  message: string,
  repairCommands: string[],
  result?: CommandResult,
): GitHubFailure {
  return {
    ok: false,
    code,
    message,
    repairCommands,
    command: result?.command,
    output: result?.output || result?.errorMessage ? truncateOutput([result?.output, result?.errorMessage].filter(Boolean).join("\n")) : undefined,
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

function authMessage(remote: GitHubRemote): string {
  return `GitHub CLI is not authenticated for ${remote.host}.`;
}

function repoMessage(remote: GitHubRemote): string {
  return `GitHub CLI cannot view ${remote.repoArg}. Check repository existence and read/write permissions.`;
}

function authRepair(remote: GitHubRemote): string[] {
  if (remote.host === "github.com") {
    return ["gh auth login", "gh auth status"];
  }
  return [
    `gh auth login --hostname ${remote.host}`,
    `gh auth status --hostname ${remote.host}`,
  ];
}

function authRepairForPr(remote: GitHubRemote | undefined): string[] {
  return remote ? authRepair(remote) : ["gh auth login", "gh auth status"];
}

function prRepair(branch: string, remote: GitHubRemote | undefined): string[] {
  return [
    `gh pr list --head ${branch} --state open`,
    ...authRepairForPr(remote),
    remote ? `gh repo view ${remote.repoArg}` : "gh repo view",
  ];
}

function isLikelyGitHubHost(host: string): boolean {
  return host === "github.com" || host.includes("github.");
}

function isKnownNonGitHubHost(host: string): boolean {
  return [
    "gitlab.com",
    "bitbucket.org",
    "codeberg.org",
    "sr.ht",
    "sourcehut.org",
    "dev.azure.com",
    "ssh.dev.azure.com",
  ].includes(host);
}

function looksUnauthenticated(output: string): boolean {
  return [
    /not logged in/i,
    /authentication required/i,
    /could not authenticate/i,
    /bad credentials/i,
    /\b401\b/,
    /unauthorized/i,
  ].some((pattern) => pattern.test(output));
}

function looksNetworkLike(output: string): boolean {
  return [
    /timed? out/i,
    /could not resolve host/i,
    /couldn't resolve host/i,
    /failed to connect/i,
    /connection (?:reset|refused|closed)/i,
    /network is unreachable/i,
    /no route to host/i,
    /name or service not known/i,
    /temporary failure/i,
    /\b(?:ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|EHOSTUNREACH)\b/i,
    /TLS handshake timeout/i,
  ].some((pattern) => pattern.test(output));
}

function looksGhRepoResolutionFailure(output: string): boolean {
  return /could not resolve to a Repository/i.test(output);
}

function looksRemoteNotGitHub(output: string): boolean {
  return [
    /not a GitHub(?: Enterprise Server)? host/i,
    /not a GitHub or GitHub Enterprise host/i,
    /not a GitHub Enterprise Server/i,
    /hostname .*is not.*github/i,
  ].some((pattern) => pattern.test(output));
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

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

function buildPrBody(opts: CreatePrOptions): string {
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
