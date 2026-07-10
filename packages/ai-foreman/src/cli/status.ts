import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { findResumableBranchSessions, formatBranchContinueCommand } from "../branch/resume.js";
import type { GitHubFailureCode } from "../branch/types.js";

type StatusGitHubFailureCode = GitHubFailureCode | "pr_failed";

function fail(message: string): never {
  console.error(`foreman: ${message}`);
  process.exit(1);
}

interface LatestGitHubFailure {
  ticket?: string;
  branch?: string;
  code: StatusGitHubFailureCode;
  message: string;
  repairCommands: string[];
  command?: string;
  output?: string;
}

export function buildStatusCommand(): Command {
  return new Command("status")
    .description("Summarize the most recent foreman run for a project.")
    .argument("<project>", "path to the project directory")
    .action((project: string) => {
      const projectDir = resolve(project);
      const dir = join(projectDir, ".foreman");
      if (!existsSync(dir)) fail(`no foreman runs found under ${dir}`);
      const logs = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
      if (logs.length === 0) fail(`no foreman runs found under ${dir}`);

      const latest = join(dir, logs[logs.length - 1]);
      const records = readFileSync(latest, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      const steps = records.filter((r) => r.event === "step");
      const escalations = records.filter((r) => r.event === "escalation");
      const branchEvents = records.filter((r) => String(r.event).startsWith("branch-"));
      const prEvents = records.filter((r) => ["pr-created", "pr-existing", "pr-failed"].includes(String(r.event)));
      const latestFailure = findLatestGitHubFailure(records);
      const batchEnd = [...records].reverse().find((r) => r.event === "batch-end");

      console.log(`foreman: latest run ${logs[logs.length - 1]}`);
      console.log(`foreman: ${steps.length} step record(s), ${escalations.length} escalation(s)`);
      if (branchEvents.length || prEvents.length) {
        const completed = branchEvents.filter((r) => r.event === "branch-complete").length;
        const issues = branchEvents.filter((r) => r.event === "branch-issue").length;
        const prs = prEvents.filter((r) => r.event === "pr-created" || r.event === "pr-existing").length;
        console.log(`foreman: branch mode — ${completed} completed, ${issues} issue(s), ${prs} PR(s)`);
      }
      if (batchEnd) {
        console.log(`foreman: outcome — ${batchEnd.outcome} (${batchEnd.completed}/${batchEnd.requested})`);
        if (batchEnd.detail) console.log(`foreman: ${batchEnd.detail}`);
      } else {
        console.log("ai-foreman: run is still in progress or did not finish");
      }
      if (latestFailure) {
        console.log(`foreman: latest GitHub failure — ${latestFailure.code}: ${latestFailure.message}`);
        if (latestFailure.repairCommands.length > 0) {
          console.log("foreman: repair and verify:");
          for (const command of latestFailure.repairCommands) {
            console.log(`  ${command}`);
          }
        }
        const retry = findRetryCommand(projectDir, dir, latestFailure);
        if (retry) {
          console.log("foreman: retry with:");
          console.log(`  ${retry}`);
        }
        if (latestFailure.output) {
          console.log("foreman: last command output:");
          console.log(indent(limitLines(latestFailure.output, 8)));
        }
      }
      for (const esc of escalations) {
        console.log(`  escalated: ${esc.tool} — ${esc.reason}`);
      }
    });
}

function findLatestGitHubFailure(records: Record<string, unknown>[]): LatestGitHubFailure | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!;
    const failure = githubFailureEventFromRecord(record);
    if (!failure) continue;
    if (record.event === "branch-issue") {
      const richFailure = findRelatedRichGitHubFailure(records, i, failure);
      return richFailure ? mergeGitHubFailures(richFailure, failure) : failure;
    }
    return failure;
  }
  return undefined;
}

function githubFailureEventFromRecord(record: Record<string, unknown>): LatestGitHubFailure | undefined {
  if (record.event === "github-readiness-failed") return githubFailureFromRecord(record);
  if (record.event === "pr-failed") return githubFailureFromRecord(record, "pr_create_failed");
  if (record.event === "branch-push" && record.status === "failed") return githubFailureFromRecord(record, "push_failed");
  if (record.event === "branch-issue" && isStatusGitHubFailureCode(record.code)) {
    return githubFailureFromRecord(record);
  }
  return undefined;
}

function findRelatedRichGitHubFailure(
  records: Record<string, unknown>[],
  beforeIndex: number,
  sparseFailure: LatestGitHubFailure,
): LatestGitHubFailure | undefined {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const record = records[i]!;
    if (!isRichGitHubFailureRecord(record)) continue;
    const richFailure = githubFailureEventFromRecord(record);
    if (richFailure && relatedGitHubFailure(sparseFailure, richFailure)) return richFailure;
  }
  return undefined;
}

function isRichGitHubFailureRecord(record: Record<string, unknown>): boolean {
  return record.event === "pr-failed" || (record.event === "branch-push" && record.status === "failed");
}

function relatedGitHubFailure(left: LatestGitHubFailure, right: LatestGitHubFailure): boolean {
  return sameIfKnown(left.ticket, right.ticket)
    && sameIfKnown(left.branch, right.branch)
    && normalizeLegacyFailureCode(left.code) === normalizeLegacyFailureCode(right.code);
}

function mergeGitHubFailures(preferred: LatestGitHubFailure, fallback: LatestGitHubFailure): LatestGitHubFailure {
  return {
    ticket: preferred.ticket ?? fallback.ticket,
    branch: preferred.branch ?? fallback.branch,
    code: preferred.code,
    message: preferred.message || fallback.message,
    repairCommands: preferred.repairCommands.length > 0 ? preferred.repairCommands : fallback.repairCommands,
    command: preferred.command ?? fallback.command,
    output: preferred.output ?? fallback.output,
  };
}

function githubFailureFromRecord(
  record: Record<string, unknown>,
  fallbackCode: GitHubFailureCode = "unknown",
): LatestGitHubFailure {
  const code = isStatusGitHubFailureCode(record.code)
    ? record.code
    : fallbackCode;
  return {
    ticket: stringField(record.ticket),
    branch: stringField(record.branch),
    code,
    message: stringField(record.message) ?? stringField(record.error) ?? "unknown GitHub failure",
    repairCommands: stringArray(record.repairCommands),
    command: stringField(record.command),
    output: stringField(record.output),
  };
}

function sameIfKnown(left: string | undefined, right: string | undefined): boolean {
  return !left || !right || left === right;
}

function normalizeLegacyFailureCode(code: StatusGitHubFailureCode): GitHubFailureCode {
  return code === "pr_failed" ? "pr_create_failed" : code;
}

function findRetryCommand(projectDir: string, foremanDir: string, failure: LatestGitHubFailure): string | undefined {
  const sessions = findResumableBranchSessions(foremanDir);
  const session = failure.ticket
    ? sessions.find((candidate) => candidate.ticket === failure.ticket)
    : sessions.length === 1
      ? sessions[0]
      : undefined;
  return session ? formatBranchContinueCommand(projectDir, session) : undefined;
}

function isGitHubFailureCode(value: unknown): value is GitHubFailureCode {
  return [
    "gh_missing",
    "gh_not_authenticated",
    "remote_missing",
    "remote_not_github",
    "repo_unreachable",
    "git_remote_unreachable",
    "push_failed",
    "pr_create_failed",
    "network_or_timeout",
    "unknown",
  ].includes(String(value));
}

function isStatusGitHubFailureCode(value: unknown): value is StatusGitHubFailureCode {
  return value === "pr_failed" || isGitHubFailureCode(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function limitLines(value: string, max: number): string {
  const lines = value.split(/\r?\n/);
  if (lines.length <= max) return value;
  return `${lines.slice(0, max).join("\n")}\n... truncated ...`;
}

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}
