// S-CLI-1 (the command list) and S-CLI-2 (dropped and merged commands, flags and files are gone).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registry } from "../checks/registry.js";
import { snapshot } from "../checks/snapshot.js";
import { scenario } from "../harness/scenario.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

/** REQ 2.1's kept commands plus the new ones (CMD-1..CMD-37 without the dropped ones). */
const TOP_LEVEL = [
  "create", "compile", "plan", "tickets", "start", "resume", "agents", "manager", "uninstall", "uninstall:restore",
  "uninstall:cleanup", "status", "doctor", "graph", "sources", "discover", "qa-rehearse-rollback", "answer", "stop",
  "reset", "stats", "logs", "tools", "migrate", "help",
];
const TICKETS = [
  "setup:init", "setup:update", "init", "populate", "show", "waive-risk-notes", "repair", "groups", "reset", "update",
  "complete", "block", "unblock", "cancel", "discover", "accept-future-work", "reorder", "review", "render",
  "validate", "queue", "archive", "plan",
];

function listed(help: string): string[] {
  const section = help.split(/\nCommands:\n/)[1];
  if (!section) return [];
  return section.split("\n\n")[0]!.split("\n").filter((l) => /^ {2}\S/.test(l))
    .map((l) => l.trim().split(/\s+/)[0]!);
}

scenario({
  id: "S-CLI-1", covers: covers("S-CLI-1"), modes: ["next"], fixture: "none",
  async run({ rafi, step, project }) {
    const before = snapshot(project);
    await step("--version and -V print the version", async () => {
      for (const form of ["--version", "-V"]) {
        const r = await rafi(form);
        assert.equal(r.code, 0, r.output);
        assert.match(r.out, /^\d+\.\d+\.\d+/);
      }
    });
    let top: string[] = [];
    await step("--help lists every kept command and the new ones", async () => {
      const r = await rafi("--help");
      assert.equal(r.code, 0);
      top = listed(r.out);
      assert.deepEqual([...top].sort(), [...TOP_LEVEL].sort());
    });
    await step("every command and subcommand has its own help, both ways", async () => {
      const queue: string[][] = top.filter((c) => c !== "help").map((c) => [c]);
      let checked = 0;
      while (queue.length) {
        const parts = queue.shift()!;
        const viaFlag = await rafi(`${parts.join(" ")} --help`);
        const viaHelp = parts.length === 1 ? await rafi(`help ${parts[0]}`) :
          await rafi(`${parts.slice(0, -1).join(" ")} help ${parts.at(-1)}`);
        for (const r of [viaFlag, viaHelp]) {
          assert.equal(r.code, 0, `${r.argv.join(" ")}: ${r.output}`);
          assert.match(r.out, new RegExp(`Usage: rafi ${parts.join(" ")}\\b`), r.argv.join(" "));
        }
        assert.equal(viaFlag.out, viaHelp.out, parts.join(" "));
        for (const sub of listed(viaFlag.out).filter((s) => s !== "help")) queue.push([...parts, sub]);
        checked += 1;
      }
      assert.ok(checked > 60, `${checked} help pages`);
    });
    await step("tickets lists REQ 2.4's subcommands; stats lists show, timeline, export, delete", async () => {
      const tickets = listed((await rafi("tickets --help")).out).filter((s) => s !== "help");
      assert.deepEqual(tickets.sort(), [...TICKETS].sort());
      const stats = listed((await rafi("stats --help")).out).filter((s) => s !== "help");
      assert.deepEqual(stats, ["show", "timeline", "export", "delete"]);
      assert.ok(!stats.includes("compare") && !stats.includes("replay"));
    });
    await step("nothing was written", () => assert.deepEqual(snapshot(project), before));
  },
});

const DROPPED_COMMANDS: [string, RegExp | null][] = [
  ["plan:doctor", /rafi resume/], ["build:attach", /rafi resume/], ["build:resume", /rafi resume/],
  ["build:decide", /rafi answer/], ["build:stop", /rafi stop/], ["build:start-over", /rafi reset/],
  ["build:reset", /rafi reset/], ["audit", /rafi stats show/], ["state", /built in/], ["handoffs", null],
  ["tickets import", null],
];
const DROPPED_FLAGS: [string, RegExp | null][] = [
  ...["-t x", "-r x", "--continue", "--recover-run r1", "--recovery-mode fresh", "--recovery-decision-digest d",
    "--qa-revision 2", "--accept-handoff 3", "--accept-handoff-role builder", "--no-supervisor"]
    .map((f) => [`start . --steps 1 ${f}`, null] as [string, null]),
  ["start . --steps 1 --autonomy balanced", /retries/],
  ...["--qa-revision 2", "--no", "--fresh-with-handoff", "--fresh-session", "--guided-recovery"]
    .map((f) => [`resume ${f}`, null] as [string, null]),
  ["resume --inspect", /rafi status/], ["plan . --skip-run-confirmation", null],
  ["tickets init --queue-limit 5", null], ["manager --ask /qa-conflicts", /unknown Manager command/],
  ["manager --ask /qa-repair-plan", /unknown Manager command/], ["manager --ask '/qa-repair {}'", /Manager/],
];
const START_MERGED: [string, RegExp][] = [
  ["--builder-network", /--allow/], ["--qa-network", /--allow/], ["--builder-approvals", /--allow/],
  ["--create-pr", /--completion/], ["--no-create-pr", /--completion/], ["--pr-ready", /--completion pr-ready/],
  ["--merge-method squash", /tickets\.build\.merge_method/], ["--provider github", /tickets\.build\.provider/],
  ["--auto-merge-wait", /tickets\.build\.auto_merge_wait/], ["--no-auto-merge-wait", /tickets\.build\.auto_merge_wait/],
  ["--auto-merge-timeout-minutes 5", /tickets\.build\.auto_merge_timeout_minutes/],
  ["--branch-prefix x/", /tickets\.build\.branch_prefix/], ["--max-branch-depth 3", /tickets\.build\.max_branch_depth/],
  ["--keep-worktrees", /tickets\.build\.keep_worktrees/], ["--show-session-cost", /display_session_cost/],
  ["--hide-session-cost", /display_session_cost/], ["--audit-logging trace", /logs\.capture/],
  ["--auto-compact-threshold 80", /auto_compact_threshold_percent/],
];

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pkg = (name: string) => JSON.parse(readFileSync(path.join(repo, "packages", name, "package.json"), "utf8"));

scenario({
  id: "S-CLI-2", covers: covers("S-CLI-2"), modes: ["next"], fixture: "F-ONE",
  async run({ rafi, step, project, clean }) {
    const before = snapshot(project);
    const refused = async (line: string, names: RegExp | null) => {
      const r = await rafi(line);
      assert.equal(r.code, 1, `${line}: ${r.output}`);
      assert.match(r.err, /^rafi: unknown (command|option|Manager command)/, line);
      if (names) assert.match(r.err, names, line);
      assert.equal(r.err.trim().split("\n").length, 1, `${line}: one line`);
      assert.doesNotMatch(r.output, /isn't in the new engine yet/, `${line}: refused before the command runs`);
    };
    await step("1: each dropped or merged command and each dropped flag exits 1 as unknown", async () => {
      for (const [line, names] of [...DROPPED_COMMANDS, ...DROPPED_FLAGS]) await refused(line, names);
      for (const [command] of DROPPED_COMMANDS) await refused(`${command} --help`, null);
    });
    await step("2: old start and resume forms exit 1 before any turn and name what replaced them", async () => {
      for (const [flag, names] of START_MERGED) await refused(`start . --steps 1 ${flag}`, names);
      for (const flag of ["--builder-network", "--qa-network", "--builder-approvals"]) {
        await refused(`resume ${flag}`, /--allow/);
      }
    });
    await step("2: -y and --yes still work as aliases for --auto-approve", async () => {
      for (const line of ["start . --steps 1 -y", "start . --steps 1 --yes", "resume --yes",
        "start . --steps 1 --auto-approve"]) {
        const r = await rafi(line);
        assert.doesNotMatch(r.output, /unknown option/, line);
        assert.match(r.err, /isn't in the new engine yet \(milestone M[24]\)/, line);
      }
    });
    await step("1-2: nothing was written", () => {
      clean();
      assert.deepEqual(snapshot(project), before);
    });
    await step("3: no ai-foreman binary; the CLI's bin holds only rafi", () => {
      assert.deepEqual(Object.keys(pkg("rafi").bin ?? {}), ["rafi"]);
      assert.equal(pkg("engine").bin, undefined);
    });
    // Step 4 (S-CLI-2's after-each checks) runs after every scenario, this one included (harness/scenario.ts).
  },
});
