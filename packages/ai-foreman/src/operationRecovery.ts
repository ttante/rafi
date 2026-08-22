import { spawnSync } from "node:child_process";
import type { OperationRecord } from "./workflowDb.js";

export type ReconciliationResult =
  | { outcome: "confirmed"; externalId?: string; detail: string }
  | { outcome: "absent"; detail: string }
  | { outcome: "uncertain"; detail: string; inspectionCommands: string[] };

export interface RemoteReviewInspector { (intent: Record<string, unknown>): Promise<{ found: boolean; url?: string; head?: string; base?: string; uncertain?: string }> }

/** Prove a side effect before recovery decides whether the stable operation may retry. */
export async function reconcileOperation(projectDir: string, operation: OperationRecord, inspectReview?: RemoteReviewInspector): Promise<ReconciliationResult> {
  const intent = operation.intent as Record<string, unknown>;
  if (operation.status === "confirmed") return { outcome: "confirmed", externalId: operation.externalId, detail: "operation already has a confirmed receipt" };
  if (operation.kind === "commit") {
    const sha = String((operation.result as Record<string, unknown> | undefined)?.sha ?? operation.externalId ?? "");
    if (!sha) return { outcome: "absent", detail: "no commit receipt or SHA exists" };
    const exists = spawnSync("git", ["-C", projectDir, "cat-file", "-e", `${sha}^{commit}`], { encoding: "utf8" });
    return exists.status === 0 ? { outcome: "confirmed", externalId: sha, detail: `commit ${sha} exists` } : { outcome: "absent", detail: `commit ${sha} is absent` };
  }
  if (operation.kind === "push") {
    const branch = String(intent.branch ?? ""); const expected = String(intent.sha ?? "");
    const check = spawnSync("git", ["-C", projectDir, "ls-remote", "--heads", "origin", `refs/heads/${branch}`], { encoding: "utf8" });
    if (check.status !== 0) return { outcome: "uncertain", detail: check.stderr.trim() || "remote branch lookup failed", inspectionCommands: [`git -C ${quote(projectDir)} ls-remote --heads origin refs/heads/${branch}`] };
    const actual = check.stdout.trim().split(/\s+/)[0] ?? "";
    if (!actual) return { outcome: "absent", detail: `remote branch ${branch} is absent` };
    if (expected && actual !== expected) return { outcome: "uncertain", detail: `remote branch ${branch} is ${actual}, expected ${expected}`, inspectionCommands: [`git -C ${quote(projectDir)} fetch origin ${quote(branch)}`, `git -C ${quote(projectDir)} log --oneline --decorate -5 origin/${quote(branch)}`] };
    return { outcome: "confirmed", externalId: branch, detail: `remote branch ${branch} points at ${actual}` };
  }
  if (operation.kind === "pr-create" || operation.kind === "mr-create") {
    if (!inspectReview) return { outcome: "uncertain", detail: "no authenticated review inspector is available", inspectionCommands: [operation.kind === "pr-create" ? "gh pr list --state all --json url,headRefName,baseRefName" : "glab mr list --all"] };
    const result = await inspectReview(intent);
    if (result.uncertain) return { outcome: "uncertain", detail: result.uncertain, inspectionCommands: [operation.kind === "pr-create" ? "gh pr list --state all --json url,headRefName,baseRefName" : "glab mr list --all"] };
    if (!result.found) return { outcome: "absent", detail: "matching review is absent" };
    if (result.head !== intent.head || result.base !== intent.base) return { outcome: "uncertain", detail: `review head/base does not match intended ${intent.head} -> ${intent.base}`, inspectionCommands: [operation.kind === "pr-create" ? `gh pr view ${quote(result.url ?? "")}` : `glab mr view ${quote(result.url ?? "")}`] };
    return { outcome: "confirmed", externalId: result.url, detail: "matching review exists with the intended head and base" };
  }
  if (operation.kind === "ticket-complete" || operation.kind === "tracker-update") return { outcome: "uncertain", detail: "tracker reconciliation requires the tracker state adapter", inspectionCommands: ["rafi tickets validate", "rafi tickets queue"] };
  return { outcome: "uncertain", detail: `no reconciler registered for ${operation.kind}`, inspectionCommands: ["rafi status"] };
}

export function recoveryDecision(result: ReconciliationResult): "continue" | "retry" | "pause" {
  return result.outcome === "confirmed" ? "continue" : result.outcome === "absent" ? "retry" : "pause";
}
function quote(value: string): string { return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`; }
