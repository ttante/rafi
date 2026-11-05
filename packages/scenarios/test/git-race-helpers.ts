// Shared by the M5 git race tests (race-m5-git, race-m5-pr): an F-BRANCH project with T1 alone in its unit, the
// git call's own arguments, a one-shot interleaving, and a competitor's commit made without touching a checkout.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { GIT_ENV, tempRoot, git } from "../fixtures/common.js";
import { fBranch, type BranchOptions } from "../fixtures/f-branch.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import type { EventsExport } from "../checks/invariants.js";

export const T1 = "feature/T1-add-the-parser";

/** Speed: T1 alone in its unit, so `--steps 1` delivers it. */
const ONE = [{ id: "U1", tickets: ["T1"], branch_mode: "per-ticket" }, { id: "U2", tickets: ["T2", "T3", "T4"] }];

export function setup(o: BranchOptions = {}, env: Record<string, string> = {}) {
  const root = tempRoot();
  const project = fBranch(root, { units: ONE, ...o });
  const computer = newComputer(root, "a", env);
  const rafi = rafiRunner(computer, project);
  const exported = async () => JSON.parse((await rafi("stats export")).out) as EventsExport;
  const of = (e: EventsExport, type: string) => e.events.filter((x) => x.type === type);
  return { project, computer, rafi, exported, of };
}

/** The git call's own arguments, without rafi's `-c` options. */
export const own = (args: readonly string[]) => {
  const out = [...args];
  while (out[0] === "-c") out.splice(0, 2);
  return out;
};
export const once = (fn: (args: string[]) => boolean) => {
  let done = false;
  return (args: readonly string[]) => { if (!done && fn(own(args))) done = true; };
};
/** Someone else's commit of one file on `parent`, made through a temporary index (no checkout touched). */
export function commitOnto(project: string, parent: string, file: string, content: string): string {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(path.dirname(project), "other-index") };
  const run = (args: string[], input?: string) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8",
    env: { ...env, ...GIT_ENV }, input }).trim();
  run(["read-tree", parent]);
  const blob = run(["hash-object", "-w", "--stdin"], content);
  run(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`]);
  return run(["commit-tree", run(["write-tree"]), "-p", parent, "-m", "someone else"]);
}
export const trailers = (dir: string, ref: string, id: string) =>
  git(dir, ["log", "--format=%H", `--grep=^Rafi-Ticket: ${id}$`, ref]).split("\n").filter(Boolean);

