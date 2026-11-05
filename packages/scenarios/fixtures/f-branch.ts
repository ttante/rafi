// F-BRANCH (SCN 2.1 `:58`, P43; M5 plan C217): four tickets in three delivery units: U1, a per-ticket unit of T1
// and T2; then a stack of two one-ticket units, U2 (T3) then U3 (T4, depends_on U2, dependency_mode stack).
// Provider github (the fake gh); `origin` a local bare repository with `main` pushed and tracked; a committer
// identity in the repository's own config (rafi passes none, C195); QA off (speed, C159). Built once per job with
// its remote, then copied (C158); the copy's remote URL is set by editing .git/config, without a git call.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { cachedRepo } from "../harness/fixture-cache.js";
import { GIT_ENV, git, projectFiles, tempRoot, writeFiles, type FixtureTicket } from "./common.js";

export const BRANCH_TICKETS: readonly FixtureTicket[] = Object.freeze([
  { id: "T1", title: "Add the parser" }, { id: "T2", title: "Add the printer" },
  { id: "T3", title: "Add the store" }, { id: "T4", title: "Add the sync", depends_on: ["T3"] },
]);

export const BRANCH_UNITS: readonly Record<string, unknown>[] = Object.freeze([
  { id: "U1", tickets: ["T1", "T2"], branch_mode: "per-ticket" },
  { id: "U2", tickets: ["T3"] },
  { id: "U3", tickets: ["T4"], depends_on: ["U2"], dependency_mode: "stack" },
]);

const PLACEHOLDER = "@@REMOTE@@";

export interface BranchOptions {
  /** Extra rafi-config.yaml keys (merged one level deep into `tickets.build`, others replace). */
  build?: Record<string, unknown>;
  config?: Record<string, unknown>;
  units?: readonly Record<string, unknown>[];
  tickets?: readonly FixtureTicket[];
  files?: Record<string, string>;
  qa?: boolean;
}

function filesFor(o: BranchOptions): Record<string, string> {
  const tickets = o.tickets ?? BRANCH_TICKETS;
  const files = projectFiles(tickets, { harness: { qa: o.qa ?? false },
    tickets: { build: { branch_strategy: "current", completion: "none", provider: "github", ...o.build } },
    ...o.config });
  files[".tickets/delivery.yaml"] = stringify({ version: 1, units: o.units ?? BRANCH_UNITS });
  return { "README.md": "# Fixture\n", ...files, ...Object.fromEntries(tickets.map((t) => [`src/${t.id}.txt`,
    `${t.id} start\n`])), ...o.files };
}

/** The project folder; its bare remote is `<project>/../remote.git`. */
export function fBranch(root = tempRoot(), o: BranchOptions = {}): string {
  const files = filesFor(o);
  const box = cachedRepo(path.join(root, "f-branch"), { ...files, [PLACEHOLDER]: "f-branch" }, (target) => {
    const project = path.join(target, "project");
    const remote = path.join(target, "remote.git");
    mkdirSync(project, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    writeFiles(project, files);
    git(project, ["config", "user.name", "Rafi Fixture"]);
    git(project, ["config", "user.email", "fixture@example.test"]);
    git(project, ["add", "-A"]);
    git(project, ["commit", "-qm", "fixture"]);
    git(project, ["remote", "add", "origin", remote]);
    git(project, ["push", "-q", "-u", "origin", "main"]);
    const config = path.join(project, ".git", "config");
    writeFileSync(config, readFileSync(config, "utf8").split(remote).join(PLACEHOLDER));
  });
  const project = path.join(box, "project");
  const config = path.join(project, ".git", "config");
  writeFileSync(config, readFileSync(config, "utf8").split(PLACEHOLDER).join(path.join(box, "remote.git")));
  return project;
}

/** The fixture's bare remote. */
export const remoteOf = (project: string) => path.join(path.dirname(project), "remote.git");

/** A git call with the fixture's identity and fixed dates (a competitor's commit in a race test). */
export function gitAs(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
}
