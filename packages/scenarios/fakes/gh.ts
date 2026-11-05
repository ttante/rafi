// The fake `gh` and `glab` (M5 plan C216): an in-process deps.exec handler for the fast suite. It records every
// call's arguments, the names of the environment it got and the PR body file's text, and keeps a PR state machine
// (draft or ready, auto-merge on, merged or closed). `notReady` fails `auth status`; `mergeAfterViews` merges an
// auto-merge PR after that many views; `onCall` runs before each call (a race test's interleaving point, R14, R15);
// `fail` scripts a failure for a call. The state machine itself is `gh-cli.mjs`'s, shared with the process set's
// executables (C340).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExecResult } from "@rafi-ai/engine";
import * as core from "./gh-cli.mjs";

export interface FakePr {
  readonly number: number;
  readonly url: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  draft: boolean;
  state: "OPEN" | "MERGED" | "CLOSED";
  autoMerge: string | null;
  views: number;
  mergeable: "MERGEABLE" | "CONFLICTING";
}

export interface GhCall {
  readonly cmd: "gh" | "glab";
  readonly args: readonly string[];
  readonly env: readonly string[];
  readonly envValues: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

export interface FakeGh {
  readonly prs: FakePr[];
  readonly calls: GhCall[];
  notReady: boolean;
  /** An auto-merge PR merges on its n-th view (null: only when the scenario merges it). */
  mergeAfterViews: number | null;
  onCall?: (args: readonly string[], gh: FakeGh) => Promise<void> | void;
  fail?: (args: readonly string[]) => { code: number; stderr: string } | null;
}

export function fakeGh(): FakeGh {
  return { prs: [], calls: [], notReady: false, mergeAfterViews: null };
}

/** Opens a PR as the provider would (a race test's competitor uses it too). */
export function openPr(gh: FakeGh, o: { head: string; base: string; title?: string; body?: string; draft?: boolean }) {
  return core.openPr(gh, o) as FakePr;
}

/** C340: `gh` and `glab` executables in `bin` over the state file `state` (created from `gh`'s data). */
export function writeGhExecutables(bin: string, state: string, gh: FakeGh = fakeGh()): void {
  mkdirSync(bin, { recursive: true });
  core.saveState(gh, state);
  const cli = pathToFileURL(fileURLToPath(new URL("./gh-cli.mjs", import.meta.url))).href;
  for (const cmd of ["gh", "glab"] as const) {
    const file = path.join(bin, cmd);
    writeFileSync(file, `#!/usr/bin/env node\nimport(${JSON.stringify(cli)}).then((m) => ` +
      `m.main(${JSON.stringify(state)}, ${JSON.stringify(cmd)}, process.argv.slice(2)));\n`);
    chmodSync(file, 0o755);
  }
}

/** The executables' state file, read back (the same shape as the in-process fake's data). */
export const readGhState = (state: string): FakeGh => core.loadState(state) as FakeGh;

export async function runGh(gh: FakeGh, cmd: "gh" | "glab", args: readonly string[],
  o: { cwd: string; env?: Readonly<Record<string, string | undefined>> }): Promise<ExecResult> {
  await gh.onCall?.(args, gh);
  gh.calls.push(core.record(cmd, args, o.cwd, o.env) as GhCall);
  const scripted = gh.fail?.(args);
  if (scripted) return { code: scripted.code, stdout: "", stderr: scripted.stderr };
  return core.handle(gh, args) as ExecResult;
}

/** The scenario merges a PR (as a person or the provider's auto-merge would). */
export function mergePr(gh: FakeGh, url: string): void {
  const pr = gh.prs.find((p) => p.url === url);
  if (pr) pr.state = "MERGED";
}
