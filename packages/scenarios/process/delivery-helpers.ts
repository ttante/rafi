// Shared by the M5 process-set delivery rows (plan items 20, 21, 35): an F-BRANCH project for the built launcher,
// with the fake codex and the fake `gh`/`glab` executables first on PATH over one state file (C216, C340).
import path from "node:path";
import { readGhState, writeGhExecutables, type FakeGh } from "../fakes/gh.js";
import { writeShims } from "../fakes/shims.js";
import { configure, tempRoot } from "../fixtures/common.js";
import { fBranch, type BranchOptions } from "../fixtures/f-branch.js";
import { run } from "../harness/process-run.js";
import type { EventsExport } from "../checks/invariants.js";

export type Provider = "github" | "gitlab";

/** C342: the provider variables of your own shell (a real GITHUB_TOKEN) never reach these runs or their logs. */
export const PROVIDER_VARS = /^(GH_|GITHUB_|GITLAB_|GLAB_)/;

/** Not about CI: no CI point before delivery (C255). */
export const NO_CI = { checks: { ci_tests: "none" } };

export function deliverySetup(provider: Provider, o: BranchOptions & { env?: Record<string, string> } = {}) {
  const root = tempRoot("rafi-gh-proc-");
  const project = fBranch(root, { ...o, config: { ...NO_CI, ...o.config }, build: { provider, ...o.build } });
  configure(project, { harness: { targets: ["codex"] } });
  const shims = writeShims(root, { rules: [] });
  const state = path.join(root, "gh-state.json");
  writeGhExecutables(shims.bin, state);
  const opts = { cwd: project, pathFirst: shims.bin, env: o.env ?? {}, unset: PROVIDER_VARS };
  return {
    root, project, state, opts,
    gh: (): FakeGh => readGhState(state),
    exported: async () => JSON.parse((await run(["stats", "export"], opts)).output) as EventsExport,
  };
}

export const flagOf = (args: readonly string[], name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
