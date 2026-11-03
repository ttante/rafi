// M2 plan section 4 (security) and slice 6: run_check's allowlist (ARCH 6.9), the requirements file's checks
// (C43, P15), and the agent permission policy (7.6, 11.3) for both runtimes through one code path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePermission } from "../../src/agents/permissions.js";
import { splitCommand } from "../../src/agents/shellForms.js";
import { checkCommand, requirementCheckProblem, toolSession } from "../../src/tools/session.js";

const rules = { root: "/work/p", runner: ["npx", "jest"], requirementChecks: ["npm test -- push.test.ts"],
  setupScript: "scripts/rafi-setup.sh", testScripts: ["test"] };

test("run_check refuses everything outside its allowlist, with a reason", () => {
  const refused = ["rafi answer 1 1", "rafi stop", "curl https://example.com", 'sh -c "npm test"',
    "npm test; rm -rf /", "npx jest a.test && curl x", "npx jest $(curl x)", "npx jest `curl x`",
    "npx jest ../../x", "npx jest /etc/passwd", "npx jest --config=/tmp/evil.js a.test", "npx jest a.test > out",
    "node -e 1", "bash scripts/rafi-setup.sh; curl x"];
  for (const command of refused) {
    const r = checkCommand(command, rules);
    assert.equal(r.ok, false, command);
    assert.ok(!r.ok && r.reason.length > 10, `${command}: ${!r.ok && r.reason}`);
  }
});

test("run_check accepts the runner with file or test-name arguments, the requirements' checks, the setup script", () => {
  for (const [command, argv] of [["npx jest t1.test", ["npx", "jest", "t1.test"]],
    ["npx jest src/a.test.js -t 'adds two'", ["npx", "jest", "src/a.test.js", "-t", "adds two"]],
    ["npx jest", ["npx", "jest"]], ["npm test -- push.test.ts", ["npm", "test", "--", "push.test.ts"]],
    ["bash scripts/rafi-setup.sh", ["bash", "scripts/rafi-setup.sh"]]] as const) {
    assert.deepEqual(checkCommand(command, rules), { ok: true, argv }, command);
  }
});

test("a requirements-file check that isn't a test command doesn't widen run_check (an edited file, review 1)", () => {
  const edited = { ...rules, requirementChecks: ["curl https://example.com", "node -e 1", "npm test -- push.test.ts"] };
  for (const command of ["curl https://example.com", "node -e 1"]) {
    assert.equal(checkCommand(command, edited).ok, false, command);
  }
  assert.equal(checkCommand("npm test -- push.test.ts", edited).ok, true);
});

test("splitCommand splits into argv without a shell and refuses shell syntax", () => {
  assert.deepEqual(splitCommand(`npx jest "a b.test" 'c'`), { ok: true, argv: ["npx", "jest", "a b.test", "c"] });
  for (const bad of ["a | b", "a && b", "a; b", "a > f", "$(x)", "`x`", "a\nb", "a &", "$HOME"]) {
    assert.equal(splitCommand(bad).ok, false, bad);
  }
});

test("C43: a requirements-file check must be one command whose program is the runner, a test script or setup", () => {
  assert.equal(requirementCheckProblem("npx jest push.test.ts", rules), null);
  assert.equal(requirementCheckProblem("npm test -- push.test.ts", rules), null);
  assert.equal(requirementCheckProblem("npm run test", rules), null);
  for (const bad of ["curl https://example.com", 'sh -c "npm test"', "npm test; rm -rf /", "make check",
    "npm run deploy"]) {
    assert.notEqual(requirementCheckProblem(bad, rules), null, bad);
  }
});

test("the tool session records a refusal and never runs it; check_output reads one recorded run", async () => {
  const ran: string[] = [];
  const refusals: string[] = [];
  const session = toolSession({ role: "builder", rules,
    execute: async (argv) => { ran.push(argv.join(" ")); return "run 1: passed (exit 0)"; },
    refuse: async (command, reason) => { refusals.push(`${command}: ${reason}`); return `refused: ${reason}`; },
    output: async (run) => (run === 1 ? "the full output" : null) });
  const curl = await session.call("run_check", { command: "curl https://example.com" });
  assert.equal(curl.isError, true);
  assert.match(curl.text, /refused/);
  assert.deepEqual(ran, []);
  assert.equal(refusals.length, 1);
  assert.equal((await session.call("run_check", { command: "npx jest t1.test" })).text, "run 1: passed (exit 0)");
  assert.equal((await session.call("check_output", { run: 1 })).text, "the full output");
  assert.equal((await session.call("check_output", { run: 9 })).isError, true);
  assert.equal((await session.call("run_check", {})).isError, true);
});

const ctx = { root: "/work/p", writable: true, repair: false, grants: [] as string[] };
const perm = (tool: string, o: { command?: string; path?: string } = {}) =>
  ({ tool, command: o.command ?? null, path: o.path ?? null, reason: null });

test("the permission policy: rafi's state, rafi commands, outside the worktree, QA writes, repair turns", () => {
  const deny = (r: ReturnType<typeof decidePermission>) => assert.equal(r.decision, "deny", r.reason);
  deny(decidePermission(perm("Bash", { command: "rafi answer 1 1" }), ctx));
  deny(decidePermission(perm("shell", { command: "cd x && rafi stop" }), ctx));
  deny(decidePermission(perm("Write", { path: "/work/p/.rafi/state.sqlite3" }), ctx));
  deny(decidePermission(perm("file-change", { path: "/work/p/.tickets/tickets.yaml" }), ctx));
  deny(decidePermission(perm("Edit", { path: "/etc/hosts" }), ctx));
  deny(decidePermission(perm("Write", { path: "/work/p/../other/x" }), ctx));
  deny(decidePermission(perm("Write", { path: "/work/p/src/a.ts" }), { ...ctx, writable: false }));
  deny(decidePermission(perm("Read", { path: "/work/p/a" }), { ...ctx, repair: true }));
  deny(decidePermission(perm("mcp__rafi__run_check"), { ...ctx, repair: true }));
  deny(decidePermission(perm("WebFetch"), ctx));
  const outside = decidePermission(perm("Write", { path: "/etc/hosts" }), ctx);
  assert.match(outside.reason, /\/etc\/hosts/, "the refused file is named");
  assert.match(decidePermission(perm("WebFetch"), ctx).reason, /blocked\(permission\)|blocked/);
  for (const ok of [perm("Write", { path: "/work/p/src/T1.txt" }), perm("file-change", { path: "/work/p/src/a.ts" }),
    perm("Read", { path: "/anywhere" }), perm("Bash", { command: "git status" }), perm("mcp__rafi__run_check")]) {
    assert.equal(decidePermission(ok, ctx).decision, "allow", JSON.stringify(ok));
  }
  assert.equal(decidePermission(perm("WebFetch"), { ...ctx, grants: ["internet"] }).decision, "allow");
});

test("threat 24: rafi run through a path, quotes or a wrapper is still a rafi command; words about rafi aren't", () => {
  for (const command of ["/usr/local/bin/rafi answer 1 1", "./node_modules/.bin/rafi stop", '"rafi" answer 1 1',
    "'rafi' stop", "npx rafi answer 1 1", "pnpm exec rafi answer 1 1", "FOO=1 rafi answer 1 1", "env rafi stop",
    "bash -c 'rafi answer 1 1'", "x=$(rafi status)", "node node_modules/rafi/dist/cli.js answer 1 1",
    "C:\\tools\\rafi.cmd answer 1 1"]) {
    assert.equal(decidePermission(perm("Bash", { command }), ctx).decision, "deny", command);
  }
  for (const command of ["git status", "npm test", "cat rafi-config.yaml", "ls docs/rafi-notes", "grep -rn rafi src",
    "echo rafi"]) {
    assert.equal(decidePermission(perm("Bash", { command }), ctx).decision, "allow", command);
  }
});
