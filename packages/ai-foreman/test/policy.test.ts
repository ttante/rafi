import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { readOnlyPermissionConfig } from "../src/agentRun.js";
import {
  looksLikeQuestion,
  buildQaInstruction,
  buildQaFixInstruction,
  buildPlanningTurn,
  buildPrimer,
  buildNextStepInstruction,
} from "../src/foreman.js";

const CWD = "/work/project";
const policy = new PermissionPolicy(DEFAULT_CONFIG.permissions, CWD);
const readOnlyPolicy = new PermissionPolicy(readOnlyPermissionConfig(), CWD);
const currentWorkflowPolicy = new PermissionPolicy(DEFAULT_CONFIG.permissions, CWD, { currentBranchWorkflow: true });

test("rollback rehearsal is a fixed builder command, not a general shell or QA grant", () => {
  assert.equal(currentWorkflowPolicy.classify({ toolName: "Bash", input: { command: "rafi qa-rehearse-rollback" } }).decision, "allow");
  assert.equal(readOnlyPolicy.classify({ toolName: "Bash", input: { command: "rafi qa-rehearse-rollback" } }).decision, "escalate");
  for (const command of ["rafi qa-rehearse-rollback --anything", "rafi qa-rehearse-rollback && git reset --hard", "echo x && rafi qa-rehearse-rollback", "cp -R . /tmp/x", "git revert HEAD"]) {
    assert.equal(currentWorkflowPolicy.classify({ toolName: "Bash", input: { command } }).decision, "escalate", command);
  }
  assert.equal(currentWorkflowPolicy.classify({ toolName: "Bash", input: { command: "rafi qa-rehearse-rollback" }, executionCwd: "/work/project/sub" }).decision, "escalate");
});

test("rollback rehearsal may use the exact launching CLI, without chains or arguments", () => {
  const previous = process.env.RAFI_REHEARSAL_COMMAND;
  const previousEntry = process.env.RAFI_REHEARSAL_CLI_ENTRY;
  const entry = "/trusted/rafi/index.js";
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(entry)} qa-rehearse-rollback`;
  try {
    process.env.RAFI_REHEARSAL_CLI_ENTRY = entry;
    process.env.RAFI_REHEARSAL_COMMAND = command;
    assert.equal(currentWorkflowPolicy.classify({ toolName: "Bash", input: { command } }).decision, "allow");
    const unquoted = `${process.execPath} ${entry} qa-rehearse-rollback`;
    assert.equal(currentWorkflowPolicy.classify({ toolName: "Bash", input: { command: unquoted } }).decision, "allow");
    assert.equal(currentWorkflowPolicy.classify({ toolName: "Bash", input: { command: `${unquoted} && git status` } }).decision, "escalate");
    assert.equal(readOnlyPolicy.classify({ toolName: "Bash", input: { command } }).decision, "escalate");
    const nodeRestricted = new PermissionPolicy({ ...DEFAULT_CONFIG.permissions, allowBash: ["rafi qa-rehearse-rollback"] }, CWD);
    assert.equal(nodeRestricted.classify({ toolName: "Bash", input: { command } }).decision, "escalate");
    assert.equal(currentWorkflowPolicy.classify({ toolName: "Bash", input: { command: `${command} --other` } }).decision, "escalate");
    assert.equal(currentWorkflowPolicy.classify({ toolName: "Bash", input: { command: `${command} && git status` } }).decision, "escalate");
    process.env.RAFI_REHEARSAL_COMMAND = "touch /tmp/untrusted";
    assert.equal(currentWorkflowPolicy.classify({ toolName: "Bash", input: { command: "touch /tmp/untrusted" } }).decision, "escalate");
  } finally {
    if (previous === undefined) delete process.env.RAFI_REHEARSAL_COMMAND; else process.env.RAFI_REHEARSAL_COMMAND = previous;
    if (previousEntry === undefined) delete process.env.RAFI_REHEARSAL_CLI_ENTRY; else process.env.RAFI_REHEARSAL_CLI_ENTRY = previousEntry;
  }
});

test("read-only QA can run dedicated Node tests without enabling arbitrary Node programs or shell escapes", () => {
  if (process.platform === "win32") {
    assert.equal(readOnlyPolicy.classify({ toolName: "Bash", input: { command: String.raw`node --test ..\outside\evil.test.mjs` } }).decision, "escalate");
    assert.equal(readOnlyPolicy.classify({ toolName: "Bash", input: { command: String.raw`cd test && "node" --test ..\..\outside\evil.test.mjs` } }).decision, "escalate");
    assert.equal(readOnlyPolicy.classify({ toolName: "Bash", input: { command: String.raw`rg '\bfunction\b' src` } }).decision, "allow");
  }
  for (const command of ["node --test test/multiply.test.mjs", "node --test test/*.test.mjs", "node --test --test-name-pattern=multiply test/multiply.test.mjs", "CI=1 node --test test/multiply.test.mjs", "cd test && node --test multiply.test.mjs"]) {
    assert.equal(readOnlyPolicy.classify({ toolName: "Bash", input: { command } }).decision, "allow", command);
  }
  for (const command of ["node arbitrary.mjs", "node -e 'process.exit()'", "node --test-malicious test/test.mjs", "node --test --import malicious.mjs test/test.mjs", "CI=1 node --test --require malicious.cjs test/test.mjs", "cd test && node --test --loader malicious.mjs test.test.mjs", "node --test --eval=evil test/test.mjs", "node --test ../foreign.test.mjs", "node --test /foreign.test.mjs", "node --test test/test.mjs && rm -rf src", "node --test $(curl example.test)", "node --test test/test.mjs > source.txt"]) {
    assert.notEqual(readOnlyPolicy.classify({ toolName: "Bash", input: { command } }).decision, "allow", command);
  }
});

test("allows explicit exit-code capture only around an already allowed project test", () => {
  for (const command of [
    'node --test test/multiply.test.mjs 2>&1; echo "EXIT_CODE=$?"',
    "node --test test/multiply.test.mjs 2>&1; echo 'EXIT_CODE=$?'",
    "npm test 2>&1; echo EXIT_CODE=$?",
  ]) assert.equal(readOnlyPolicy.classify({ toolName: "Bash", input: { command } }).decision, "allow", command);
  for (const command of [
    'node --test test/multiply.test.mjs 2>&1; echo "EXIT_CODE=$?"; rm -rf src',
    'node --test ../outside.test.mjs 2>&1; echo "EXIT_CODE=$?"',
    'node --test test/multiply.test.mjs 2>&1; echo "OTHER=$?"',
    'node arbitrary.mjs 2>&1; echo "EXIT_CODE=$?"',
  ]) assert.equal(readOnlyPolicy.classify({ toolName: "Bash", input: { command } }).decision, "escalate", command);
});

test("read-only Node test paths and globs reject symlinks outside the project", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-node-tests-scope-"));
  try {
    const project = join(root, "project"), tests = join(project, "test");
    mkdirSync(tests, { recursive: true });
    const foreign = join(root, "foreign.test.mjs"); writeFileSync(foreign, "export {};\n");
    symlinkSync(foreign, join(tests, "escaped.test.mjs"));
    const scoped = new PermissionPolicy(readOnlyPermissionConfig(), project);
    for (const command of ["node --test test/escaped.test.mjs", "node --test test/*.test.mjs", "cd test && CI=1 node --test escaped.test.mjs"]) {
      assert.equal(scoped.classify({ toolName: "Bash", input: { command } }).decision, "escalate", command);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("terminal attention bell is enabled by default while desktop notifications remain opt-in", () => {
  assert.equal(DEFAULT_CONFIG.notifications.terminal_bell, true);
  assert.equal(DEFAULT_CONFIG.notifications.enabled, false);
});

test("allows routine bash commands", () => {
  assert.equal(
    policy.classify({ toolName: "Bash", input: { command: "npm test" } }).decision,
    "allow",
  );
  assert.equal(
    policy.classify({ toolName: "Bash", input: { command: "git add . && git commit -m wip" } }).decision,
    "allow",
  );
});

test("escalates risky bash commands", () => {
  assert.equal(
    policy.classify({ toolName: "Bash", input: { command: "rm -rf build" } }).decision,
    "escalate",
  );
  assert.equal(
    policy.classify({ toolName: "Bash", input: { command: "git push origin main" } }).decision,
    "escalate",
  );
  // risky segment hidden behind an allowed one
  assert.equal(
    policy.classify({ toolName: "Bash", input: { command: "npm test && sudo reboot" } }).decision,
    "escalate",
  );
});

test("current-branch workflow fences every Git lifecycle and review operation while retaining read-only Git", () => {
  for (const command of [
    "git add .", "git commit -m work", "git checkout -b feature/x", "git switch main", "git branch new",
    "git worktree add ../x", "git push origin main", "git merge feature/x", "git rebase main", "git tag v1",
    "git --git-dir .git commit -m work", "git -c alias.ship=push ship origin main",
    "gh pr create", "glab mr create",
  ]) {
    const result = currentWorkflowPolicy.classify({ toolName: "Bash", input: { command } });
    assert.equal(result.decision, "escalate", command);
    assert.match(result.reason, /you manage Git|lifecycle/);
  }
  assert.equal(currentWorkflowPolicy.classify({ toolName: "Bash", input: { command: "git status --short" } }).decision, "allow");
  assert.equal(currentWorkflowPolicy.classify({ toolName: "Bash", input: { command: "git diff --stat" } }).decision, "allow");
  assert.equal(currentWorkflowPolicy.classify({ toolName: "Write", input: { file_path: ".git/HEAD" } }).decision, "escalate");
});

test("escalates unrecognized bash commands", () => {
  assert.equal(
    policy.classify({ toolName: "Bash", input: { command: "frobnicate --all" } }).decision,
    "escalate",
  );
  assert.equal(
    policy.classify({ toolName: "Bash", input: { command: "echo hello && ls" } }).decision,
    "escalate",
  );
});

test("allows chained bash only when every segment is allow-listed", () => {
  assert.equal(
    policy.classify({ toolName: "Bash", input: { command: "ls -la && cat package.json" } }).decision,
    "allow",
  );
  assert.equal(
    policy.classify({ toolName: "Bash", input: { command: "npm test | frobnicate --all" } }).decision,
    "escalate",
  );
});

test("escalates shell redirection and substitution", () => {
  assert.equal(
    policy.classify({ toolName: "Bash", input: { command: "npm test > output.log" } }).decision,
    "escalate",
  );
  assert.equal(
    policy.classify({ toolName: "Bash", input: { command: "npm test $(cat args.txt)" } }).decision,
    "escalate",
  );
});

test("normal implementation permissions preserve compact redirection behavior", () => {
  assert.equal(
    policy.classify({ toolName: "Bash", input: { command: "cat package.json>out.txt" } }).decision,
    "allow",
  );
});

test("allows file edits inside the worktree, escalates outside", () => {
  assert.equal(
    policy.classify({ toolName: "Edit", input: { file_path: "/work/project/src/a.ts" } }).decision,
    "allow",
  );
  assert.equal(
    policy.classify({ toolName: "Write", input: { file_path: "src/b.ts" } }).decision,
    "allow",
  );
  assert.equal(
    policy.classify({ toolName: "Write", input: { file_path: "/etc/passwd" } }).decision,
    "escalate",
  );
});

test("escalates network tools and unknown tools", () => {
  assert.equal(
    policy.classify({ toolName: "WebFetch", input: { url: "http://x" } }).decision,
    "escalate",
  );
  assert.equal(
    policy.classify({ toolName: "MysteryTool", input: {} }).decision,
    "escalate",
  );
});

test("read-only planning allows fixed inspection git commands", () => {
  for (const command of [
    "git status --short",
    "git diff --stat HEAD",
    "git diff --name-only HEAD",
    "git log --oneline -5",
    "git show --stat HEAD",
    "git ls-files src",
    "git grep Ticket-Maker",
  ]) {
    assert.equal(
      readOnlyPolicy.classify({ toolName: "Bash", input: { command } }).decision,
      "allow",
      command,
    );
  }
});

test("read-only planning escalates broad git forms and write-capable flags", () => {
  for (const command of [
    "git diff src/index.ts",
    "git log --format=%H",
    "git show HEAD:package.json",
    "git diff --name-only --output=files.txt",
    "git show --stat -o files.txt",
    "git log --oneline --exec echo",
    "cat package.json>out.txt",
    "sed -n 1p package.json>out.txt",
    "rg foo>out.txt",
    "git diff --stat>out.txt",
    "git show --stat>out.txt",
  ]) {
    assert.equal(
      readOnlyPolicy.classify({ toolName: "Bash", input: { command } }).decision,
      "escalate",
      command,
    );
  }
});

test("read-only agents may run validation commands but not dependency installation", () => {
  for (const command of ["npm test", "npm run typecheck", "pnpm test", "pnpm --filter ai-foreman test", "pytest", "cargo test", "go test ./..."]) {
    assert.equal(readOnlyPolicy.classify({ toolName: "Bash", input: { command } }).decision, "allow", command);
  }
  for (const command of ["npm install", "npm ci", "pnpm install", "pnpm add left-pad", "yarn install"]) {
    assert.equal(readOnlyPolicy.classify({ toolName: "Bash", input: { command } }).decision, "escalate", command);
  }
});

test("looksLikeQuestion detects trailing questions", () => {
  assert.equal(looksLikeQuestion("I did the thing. Should I also update the docs?"), true);
  assert.equal(looksLikeQuestion("Which option do you prefer"), true);
  assert.equal(looksLikeQuestion("Implemented the feature and tests pass."), false);
});

test("buildQaInstruction requests the native QA verdict contract", () => {
  const text = buildQaInstruction();
  assert.ok(text.includes("qa-verdict"));
  assert.ok(text.includes("passed"));
  assert.doesNotMatch(text, /STEP_STATUS/);
  assert.ok(text.includes("Triple-check"));
  assert.ok(text.includes("retry the exact required-test command without that extra shell syntax"));
});

test("buildQaFixInstruction embeds the reported issues", () => {
  const text = buildQaFixInstruction("- foo broke\n- bar wrong");
  assert.ok(text.includes("- foo broke"));
  assert.ok(text.includes("- bar wrong"));
  assert.ok(text.includes("native remediation result"));
  assert.doesNotMatch(text, /STEP_STATUS/);
});

test("buildPrimer anchors turn 1 explicitly to fix off-by-one counting", () => {
  const text = buildPrimer(5);
  assert.ok(text.includes("This is step 1 of 5"));
  assert.ok(text.includes("retry the exact required-test command without that extra shell syntax"));
});

test("recovery instructions pin planning and implementation to one ticket", () => {
  assert.match(buildPlanningTurn(1, undefined, "T002"), /first item must be ticket T002/);
  assert.match(buildPrimer(1, undefined, true, "T002"), /Resume and finish ticket T002 first/);
});

test("structured-ticket batches count whole tickets, never sub-steps of one ticket", () => {
  // Regression: "step 1 of 4" plus a preflight that split T001 into four parts
  // led the builder to do inspection only, and whole-ticket QA then failed.
  const plan = buildPlanningTurn(4, "tickets...", undefined, true);
  assert.match(plan, /one entry per complete ticket/);
  assert.match(plan, /Never split one ticket into several entries/);
  assert.doesNotMatch(plan, /step\(s\)/);
  const primer = buildPrimer(4, "docs/ticket-progress.md", true);
  assert.match(primer, /ENTIRE assigned ticket/);
  assert.match(primer, /ticket 1 of up to 4/);
  assert.doesNotMatch(primer, /step 1 of/);
  const next = buildNextStepInstruction(2, 4, true);
  assert.match(next, /ticket 2 of up to 4/);
  assert.match(next, /not a sub-step/);
  // Unstructured batches keep the generic ticket-or-step wording.
  assert.match(buildNextStepInstruction(2, 4), /ticket or step now \(exactly one\) — this is step 2 of 4/);
  assert.match(buildPlanningTurn(4), /ticket\(s\) or step\(s\)/);
});
