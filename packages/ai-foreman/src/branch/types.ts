import type { TicketDef } from "../tickets/ticketSchema.js";

export interface BranchPlanNode {
  ticket: TicketDef;
  branch: string;
  baseRef: string;
  baseBranch: string;
  dependencies: string[];
  depth: number;
  worktreePath?: string;
  /** Shared delivery units intentionally reuse one isolated branch/worktree. */
  deliveryUnitId?: string;
  deliveryUnitFinal?: boolean;
}

export interface BranchIssue {
  ticket?: string;
  code:
    | "cycle"
    | "depth_exceeded"
    | "multi_root_join"
    | "blocked"
    | "dirty_worktree"
    | "branch_switch"
    | "tracker_touched"
    | "builder_error"
    | "qa_failed"
    | "no_changes"
    | "push_failed"
    | "pr_create_failed"
    | "dependency_unavailable"
    | GitHubFailureCode;
  message: string;
  blocking: boolean;
}

export type GitHubFailureCode =
  | "gh_missing"
  | "glab_missing"
  | "gh_not_authenticated"
  | "glab_not_authenticated"
  | "remote_missing"
  | "remote_not_github"
  | "remote_not_gitlab"
  | "repo_unreachable"
  | "git_remote_unreachable"
  | "push_failed"
  | "pr_create_failed"
  | "mr_create_failed"
  | "network_or_timeout"
  | "unknown";

export interface GitHubFailure {
  ok: false;
  code: GitHubFailureCode;
  message: string;
  repairCommands: string[];
  command?: string;
  output?: string;
}

export interface GitHubRemote {
  remoteUrl: string;
  host: string;
  owner: string;
  repo: string;
  repoArg: string;
  likelyGitHub: boolean;
}

export type GitHubRemoteResult = { ok: true; remote: GitHubRemote } | GitHubFailure;
export type GitHubReadinessResult = { ok: true; remote: GitHubRemote } | GitHubFailure;
export type GitHubOperationResult = { ok: true; output?: string } | GitHubFailure;
export type ReviewMergeStatus = { ok: true; merged: boolean; state?: string; url?: string } | GitHubFailure;

export interface BranchPlan {
  baseRef: string;
  nodes: BranchPlanNode[];
  issues: BranchIssue[];
}

export type CompletionMode = "none" | "pr" | "auto-merge" | "direct-merge";
export type ReviewProvider = "github" | "gitlab";
export type MergeMethod = "squash" | "merge" | "rebase";

export interface PrResult {
  status: "created" | "existing" | "failed" | "skipped" | "auto_merge_enabled" | "merged";
  url?: string;
  error?: string;
  code?: GitHubFailureCode;
  message?: string;
  repairCommands?: string[];
  command?: string;
  output?: string;
}

export interface BranchRunSummary {
  ticket: string;
  branch: string;
  base: string;
  buildStatus: "done" | "blocked" | "needs-human" | "skipped";
  commit?: string;
  pushStatus?: "pushed" | "failed" | "skipped";
  pr?: PrResult;
  detail?: string;
}
