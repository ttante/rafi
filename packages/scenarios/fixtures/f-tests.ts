// F-TESTS-LOCAL (SCN 2.1): F-TESTS with git left to you: three tickets T1–T3, one shared delivery unit, current
// branch, completion none, `git.managed_by: me`. The test runner is `fake-test` (the scripted deps.checks.run,
// fakes/checks.ts); each ticket's check is `fake-test t<n>.test`. `src/index.js` is a tracked code file for edits.
import path from "node:path";
import { stringify } from "yaml";
import { gitRepo, projectFiles, tempRoot, type FixtureTicket } from "./common.js";

export const TESTS_TICKETS: readonly FixtureTicket[] = Object.freeze([1, 2, 3].map((n) => ({
  id: `T${n}`, title: `Ticket ${n}`, required_tests: [`fake-test t${n}.test`],
  likely_files: [`src/T${n}.txt`, "src/index.js"],
})));

/** `runner` replaces fake-test as the test runner and in each ticket's required test (S-CHK-9: `npx jest`). */
export function fTestsLocal(root = tempRoot(), extra: Record<string, unknown> = {}, runner = "fake-test"): string {
  const tickets = TESTS_TICKETS.map((t) => ({ ...t, required_tests: [`${runner} ${t.id.replace("T", "t")}.test`] }));
  const files = projectFiles(tickets, { checks: { test_runner: runner }, git: { managed_by: "me" }, ...extra });
  files[".tickets/delivery.yaml"] = stringify({ delivery_units: [{ id: "U-1", tickets: ["T1", "T2", "T3"],
    completion: "none" }] });
  return gitRepo(path.join(root, "f-tests-local"), { ...files, "src/index.js": "module.exports = 1;\n",
    "t1.test": "// fake-test t1\n", "t2.test": "// fake-test t2\n", "t3.test": "// fake-test t3\n",
    ".gitignore": "coverage/\n" });
}
