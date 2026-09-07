import { currentWorktreeBranch, findWorktreeForBranch, hasWorktreeChanges, mergeBranchToLocalBase, runGit } from "./git.js";
import { captureProspectiveGitTree } from "../qaSnapshot.js";

export interface DirectMergeIntent {
  version: 1;
  ticket: string;
  branch: string;
  base: string;
  sourceCommit: string;
  baseCommit: string;
  expectedTree: string;
  method: "squash" | "merge" | "rebase";
}

export class DirectMergeSourceChangedError extends Error {}

/** Freeze both inputs and the resulting tree before any merge mutates refs. */
export function prepareDirectMerge(projectDir: string, ticket: string, branch: string, base: string, method: DirectMergeIntent["method"]): DirectMergeIntent {
  const sourceCommit = runGit(projectDir, ["rev-parse", branch]).stdout;
  const baseCommit = runGit(projectDir, ["rev-parse", base]).stdout;
  const expectedTree = runGit(projectDir, ["merge-tree", "--write-tree", baseCommit, sourceCommit]).stdout.split("\n")[0]!;
  if (!/^[a-f0-9]{40,64}$/.test(expectedTree)) throw new Error("Git did not produce a bound direct-merge tree");
  return { version: 1, ticket, branch, base, sourceCommit, baseCommit, expectedTree, method };
}

export function readDirectMergeIntent(value: unknown): DirectMergeIntent {
  const intent = value as DirectMergeIntent;
  if (!intent || intent.version !== 1 || !intent.ticket || !intent.branch || !intent.base
    || ![intent.sourceCommit, intent.baseCommit, intent.expectedTree].every((item) => typeof item === "string" && /^[a-f0-9]{40,64}$/.test(item))
    || !["squash", "merge", "rebase"].includes(intent.method)) throw new Error("Direct merge is missing its durable source/base/tree intent");
  return intent;
}

/** Recognize a merge that reached Git before its SQLite completion receipt. */
export function reconcileDirectMerge(projectDir: string, intent: DirectMergeIntent): string | undefined {
  const base = runGit(projectDir, ["rev-parse", intent.base]).stdout;
  if (base === intent.baseCommit) return undefined;
  try { runGit(projectDir, ["merge-base", "--is-ancestor", intent.baseCommit, base]); }
  catch { throw new Error("Direct-merge base was rewritten after its durable intent"); }
  const commits = runGit(projectDir, ["rev-list", "--first-parent", "--reverse", `${intent.baseCommit}..${base}`]).stdout.split("\n").filter(Boolean);
  for (const commit of commits) {
    if (runGit(projectDir, ["rev-parse", `${commit}^{tree}`]).stdout !== intent.expectedTree) continue;
    const parents = runGit(projectDir, ["show", "-s", "--format=%P", commit]).stdout.split(" ");
    if (intent.method === "squash" && parents.length === 1 && parents[0] === intent.baseCommit) return commit;
    if (intent.method === "merge" && parents[0] === intent.baseCommit && parents.includes(intent.sourceCommit)) return commit;
    if (intent.method === "rebase") return commit;
  }
  throw new Error("Direct-merge base changed without the intended merge result; reconcile the base before retrying");
}

/** Refuse to discard changes made while the interrupted recovery was paused. */
export function verifyDirectMergeWorktree(projectDir: string, intent: DirectMergeIntent): string | undefined {
  const worktree = findWorktreeForBranch(projectDir, intent.branch);
  if (worktree && hasWorktreeChanges(worktree)) throw new DirectMergeSourceChangedError(`Direct-merge worktree has new changes and must be preserved: ${worktree}`);
  let source: string;
  try { source = runGit(projectDir, ["rev-parse", intent.branch]).stdout; }
  catch { return worktree; } // A confirmed merge may already have removed its branch.
  if (source !== intent.sourceCommit) {
    const tree = runGit(projectDir, ["rev-parse", `${source}^{tree}`]).stdout;
    let basedOnFrozenBase = false;
    try { runGit(projectDir, ["merge-base", "--is-ancestor", intent.baseCommit, source]); basedOnFrozenBase = true; } catch { /* reject below */ }
    if (intent.method !== "rebase" || tree !== intent.expectedTree || !basedOnFrozenBase) throw new DirectMergeSourceChangedError("Direct-merge source branch changed after its durable intent; preserve it for a fresh review");
  }
  return worktree;
}

export function removeDirectMergeWorktree(projectDir: string, intent: DirectMergeIntent, worktree: string): void {
  if (currentWorktreeBranch(worktree) !== intent.branch) throw new Error("Direct-merge worktree switched branches; preserve it for reconciliation");
  verifyDirectMergeWorktree(projectDir, intent);
  // Let Git reject edits made even after the preceding verification. Never
  // force-remove or recursively delete a finalization worktree on failure.
  runGit(projectDir, ["worktree", "remove", worktree]);
}

export function hasExactStagedDirectMerge(projectDir: string, intent: DirectMergeIntent): boolean {
  let recognizedMethod = intent.method === "squash";
  if (intent.method === "merge") {
    try { recognizedMethod = runGit(projectDir, ["rev-parse", "--verify", "MERGE_HEAD"]).stdout === intent.sourceCommit; } catch { return false; }
  }
  return recognizedMethod
    && runGit(projectDir, ["branch", "--show-current"]).stdout === intent.base
    && runGit(projectDir, ["rev-parse", intent.base]).stdout === intent.baseCommit
    && runGit(projectDir, ["write-tree"]).stdout === intent.expectedTree
    && captureProspectiveGitTree(projectDir) === intent.expectedTree;
}

export function executeDirectMerge(projectDir: string, intent: DirectMergeIntent, message: string): string {
  const completed = reconcileDirectMerge(projectDir, intent);
  if (completed) return completed;
  verifyDirectMergeWorktree(projectDir, intent);
  const indexTree = runGit(projectDir, ["write-tree"]).stdout;
  const baseTree = runGit(projectDir, ["rev-parse", `${intent.baseCommit}^{tree}`]).stdout;
  if (indexTree !== baseTree) {
    if (!hasExactStagedDirectMerge(projectDir, intent)) {
      throw new Error("Direct merge found unrecognized staged changes; preserve the base worktree for reconciliation");
    }
    // Git prepared the merge before the host crashed, but commit did not.
    // Only commit the exact tree frozen in the durable intent.
    runGit(projectDir, ["commit", "-m", message]);
  } else {
    // Squash/merge publish the immutable source commit, even if an external
    // actor moves the human-readable branch between verification and Git.
    mergeBranchToLocalBase(projectDir, intent.method === "rebase" ? intent.branch : intent.sourceCommit, intent.base, message, intent.method);
  }
  const result = reconcileDirectMerge(projectDir, intent);
  if (!result) throw new Error("Direct merge returned without publishing its intended result");
  return result;
}
