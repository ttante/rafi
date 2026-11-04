// Saved-answer keys (ARCH 7.6; C106): an answer applies only while what it answered is unchanged. Verdicts cite
// requirements and runs, never files, so "the files its findings cite" are the ticket's changed files in its latest
// builder snapshot; the digest is over their blob ids (`git ls-tree`), so a README-only edit leaves it as it was.
import { createHash } from "node:crypto";
import type { Env, ExecOptions, ExecResult } from "../deps/types.js";

export interface KeyDeps {
  git(args: string[], o: ExecOptions): Promise<ExecResult>;
  env: Env;
}

export const whatNextKey = (ticket: string, verdictEvent: string, digest: string) =>
  `what-next|${ticket}|${verdictEvent}|${digest}`;

export const waiverKey = (ticket: string, findings: readonly string[], digest: string) =>
  `waiver|${ticket}|${[...findings].sort().join(",")}|${digest}`;

async function lsTree(deps: KeyDeps, cwd: string, tree: string, files: readonly string[]): Promise<string> {
  if (!files.length) return "";
  const r = await deps.git(["ls-tree", "-r", tree, "--", ...files], { cwd, env: deps.env });
  if (r.code !== 0) throw new Error(`git ls-tree failed: ${r.stderr.trim().split("\n")[0]}`);
  return r.stdout;
}

export async function coveredDigest(deps: KeyDeps, cwd: string, tree: string, files: readonly string[]):
  Promise<string> {
  return `sha256:${createHash("sha256").update(await lsTree(deps, cwd, tree, files)).digest("hex")}`;
}

function blobs(listing: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of listing.split("\n").filter(Boolean)) {
    const tab = line.indexOf("\t");
    out.set(line.slice(tab + 1), line.slice(0, tab).split(" ")[2] ?? "");
  }
  return out;
}

/** The covered files whose content differs between two trees (a removed file counts). */
export async function changedCovered(deps: KeyDeps, cwd: string, from: string, to: string,
  files: readonly string[]): Promise<string[]> {
  const a = blobs(await lsTree(deps, cwd, from, files));
  const b = blobs(await lsTree(deps, cwd, to, files));
  return files.filter((f) => a.get(f) !== b.get(f)).sort();
}
