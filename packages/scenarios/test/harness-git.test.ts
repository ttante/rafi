// M4 review, finding 5: the harness runs git by its own path (C177) and, for speed, tells git to read no global
// config. That must never change what git does: the harness's git reads a user's global config exactly as
// production's `deps.git` does (HOME's .gitconfig, XDG_CONFIG_HOME's git/config, an explicit GIT_CONFIG_GLOBAL), and
// gives the same answers for a fake HOME that doesn't exist and for no HOME at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { realGit } from "@rafi-ai/engine/deps/real";
import { fakeTerminal } from "../fakes/terminal.js";
import { GIT_BINARY, harnessDeps } from "../harness/deps.js";
import { newComputer } from "../harness/rafi.js";
import { madeTemp } from "../harness/temp.js";

test("finding 5: the harness's git reads global config exactly as production's git does", async () => {
  const root = madeTemp("rafi-git-");
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  execFileSync(GIT_BINARY, ["init", "-q"], { cwd: repo, env: { GIT_CONFIG_GLOBAL: "/dev/null", HOME: root } });
  const config = (file: string, name: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `[user]\n\tname = ${name}\n`);
  };
  const withConfig = path.join(root, "home-a");
  config(path.join(withConfig, ".gitconfig"), "Global Person");
  const empty = path.join(root, "home-b");
  mkdirSync(empty);
  config(path.join(root, "explicit.gitconfig"), "From Env");
  config(path.join(root, "xdg", "git", "config"), "Xdg Person");
  const base = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const cases: [string, Record<string, string>, string][] = [
    ["HOME with a .gitconfig", { ...base, HOME: withConfig }, "Global Person"],
    ["GIT_CONFIG_GLOBAL", { ...base, HOME: empty, GIT_CONFIG_GLOBAL: path.join(root, "explicit.gitconfig") },
      "From Env"],
    ["XDG_CONFIG_HOME", { ...base, HOME: empty, XDG_CONFIG_HOME: path.join(root, "xdg") }, "Xdg Person"],
    ["an empty HOME", { ...base, HOME: empty }, ""],
    ["a fake HOME that doesn't exist", { ...base, HOME: "/home/u" }, ""],
    ["no HOME", { ...base }, ""],
  ];
  const deps = harnessDeps(newComputer(root), fakeTerminal({ tty: false }), { cwd: repo, instance: "g" }).deps;
  for (const [name, env, want] of cases) {
    const args = ["config", "--get", "user.name"];
    const harness = await deps.git(args, { cwd: repo, env });
    const production = await realGit(args, { cwd: repo, env });
    assert.equal(harness.stdout.trim(), want, `${name}: the harness's git`);
    assert.deepEqual([harness.code, harness.stdout], [production.code, production.stdout], `${name}: as production`);
  }
});
