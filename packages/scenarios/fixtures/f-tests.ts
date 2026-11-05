// F-TESTS-LOCAL (SCN 2.1): F-TESTS with git left to you: three tickets T1–T3, one shared delivery unit, current
// branch, completion none, `git.managed_by: me`. The test runner is `fake-test` (the scripted deps.checks.run,
// fakes/checks.ts); each ticket's check is `fake-test t<n>.test`. `src/index.js` is a tracked code file for edits.
import path from "node:path";
import { stringify } from "yaml";
import { gitRepo, projectFiles, tempRoot, type FixtureTicket } from "./common.js";
import { fBranch } from "./f-branch.js";

export const TESTS_TICKETS: readonly FixtureTicket[] = Object.freeze([1, 2, 3].map((n) => ({
  id: `T${n}`, title: `Ticket ${n}`, required_tests: [`fake-test t${n}.test`],
  likely_files: [`src/T${n}.txt`, "src/index.js"],
})));

/** `runner` replaces fake-test as the test runner and in each ticket's required test (S-CHK-9: `npx jest`). */
export function fTestsLocal(root = tempRoot(), extra: Record<string, unknown> = {}, runner = "fake-test"): string {
  const tickets = TESTS_TICKETS.map((t) => ({ ...t, required_tests: [`${runner} ${t.id.replace("T", "t")}.test`] }));
  const files = projectFiles(tickets, { checks: { test_runner: runner }, git: { managed_by: "me" }, ...extra });
  files[".tickets/delivery.yaml"] = stringify({ version: 1, units: [{ id: "U-1", tickets: ["T1", "T2", "T3"],
    completion: "none" }] });
  return gitRepo(path.join(root, "f-tests-local"), { ...files, "src/index.js": "module.exports = 1;\n",
    "t1.test": "// fake-test t1\n", "t2.test": "// fake-test t2\n", "t3.test": "// fake-test t3\n",
    ".gitignore": "coverage/\n" });
}

/**
 * F-TESTS (SCN 2.1 `:66`, M5 C214): T1–T3 in one shared delivery unit `U-1` completing `direct-merge` into `main`,
 * which tracks a local bare remote (`<project>/../remote.git`, F-BRANCH's builder); git managed by rafi; the test
 * runner `fake-test`, each ticket's check `fake-test t<n>.test`; the suite is every `*.test` file, including
 * `suite/x.test`, `suite/y.test` and `suite/z.test`. QA on unless `qa: false`.
 */
export function fTests(root = tempRoot(), o: { config?: Record<string, unknown>; qa?: boolean;
  units?: readonly Record<string, unknown>[] } = {}): string {
  return fBranch(root, { tickets: TESTS_TICKETS, qa: o.qa ?? true,
    units: o.units ?? [{ id: "U-1", tickets: ["T1", "T2", "T3"], branch_mode: "shared", completion: "direct-merge" }],
    config: { checks: { test_runner: "fake-test" }, git: { managed_by: "rafi" }, ...o.config },
    files: { "src/index.js": "module.exports = 1;\n", ".gitignore": "coverage/\n", "t1.test": "// fake-test t1\n",
      "t2.test": "// fake-test t2\n", "t3.test": "// fake-test t3\n", "suite/x.test": "// x\n",
      "suite/y.test": "// y\n", "suite/z.test": "// z\n" } });
}
