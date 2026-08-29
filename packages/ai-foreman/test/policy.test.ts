import { test } from "node:test";
import assert from "node:assert/strict";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { readOnlyPermissionConfig } from "../src/agentRun.js";
import {
  parseStepStatus,
  looksLikeQuestion,
  buildQaInstruction,
  buildQaFixInstruction,
  buildPlanningTurn,
  buildPrimer,
} from "../src/foreman.js";

const CWD = "/work/project";
const policy = new PermissionPolicy(DEFAULT_CONFIG.permissions, CWD);
const readOnlyPolicy = new PermissionPolicy(readOnlyPermissionConfig(), CWD);
const currentWorkflowPolicy = new PermissionPolicy(DEFAULT_CONFIG.permissions, CWD, { currentBranchWorkflow: true });

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

test("parseStepStatus reads the marker line", () => {
  const done = parseStepStatus('blah blah\nSTEP_STATUS: done | summary="did x" next="do y"');
  assert.equal(done.kind, "done");
  assert.equal(done.summary, "did x");
  assert.equal(done.next, "do y");

  const blocked = parseStepStatus('STEP_STATUS: blocked | reason="missing creds"');
  assert.equal(blocked.kind, "blocked");
  assert.equal(blocked.reason, "missing creds");

  assert.equal(parseStepStatus("no marker here").kind, "unknown");
  assert.equal(parseStepStatus("STEP_STATUS: plan_complete").kind, "plan_complete");
});

test("parseStepStatus requires one marker on the final non-empty line", () => {
  const trailing = parseStepStatus('STEP_STATUS: done | summary="did x"\nextra text');
  assert.equal(trailing.kind, "unknown");
  assert.match(trailing.error ?? "", /final/);

  const duplicate = parseStepStatus(
    'STEP_STATUS: done | summary="one"\nSTEP_STATUS: done | summary="two"',
  );
  assert.equal(duplicate.kind, "unknown");
  assert.match(duplicate.error ?? "", /multiple/);
});

test("parseStepStatus handles escaped quotes and rejects malformed fields", () => {
  const escaped = parseStepStatus('STEP_STATUS: done | summary="added \\"quoted\\" label"');
  assert.equal(escaped.kind, "done");
  assert.equal(escaped.summary, 'added "quoted" label');

  const malformed = parseStepStatus('STEP_STATUS: done | summary="unterminated');
  assert.equal(malformed.kind, "unknown");
  assert.match(malformed.error ?? "", /unterminated/);
});

test("parseStepStatus parses needs_input with question and choices", () => {
  const status = parseStepStatus(
    'STEP_STATUS: needs_input | question="Should I update tests?" choices="Yes|No|Skip for now"',
  );
  assert.equal(status.kind, "needs_input");
  assert.equal(status.question, "Should I update tests?");
  assert.deepEqual(status.choices, ["Yes", "No", "Skip for now"]);
});

test("parseStepStatus handles needs_input without choices", () => {
  const status = parseStepStatus(
    'STEP_STATUS: needs_input | question="Which approach do you prefer?"',
  );
  assert.equal(status.kind, "needs_input");
  assert.equal(status.question, "Which approach do you prefer?");
  assert.equal(status.choices, undefined);
});

test("looksLikeQuestion detects trailing questions", () => {
  assert.equal(looksLikeQuestion("I did the thing. Should I also update the docs?"), true);
  assert.equal(looksLikeQuestion("Which option do you prefer"), true);
  assert.equal(looksLikeQuestion("Implemented the feature and tests pass."), false);
});

test("parseStepStatus recognizes qa_pass", () => {
  const status = parseStepStatus(
    'all checks green\nSTEP_STATUS: qa_pass | summary="all tests pass, ticket satisfied"',
  );
  assert.equal(status.kind, "qa_pass");
  assert.equal(status.summary, "all tests pass, ticket satisfied");
});

test("parseStepStatus recognizes qa_fail and extracts issues", () => {
  const status = parseStepStatus(
    'STEP_STATUS: qa_fail | issues="missing test for empty-input case; lint warning in src/foo.ts"',
  );
  assert.equal(status.kind, "qa_fail");
  assert.equal(
    status.issues,
    "missing test for empty-input case; lint warning in src/foo.ts",
  );
});

test("parseStepStatus extracts branch_dependency", () => {
  const status = parseStepStatus(
    'STEP_STATUS: blocked | ticket="T010" branch_dependency="T003" reason="needs shared API first"',
  );
  assert.equal(status.kind, "blocked");
  assert.equal(status.ticket, "T010");
  assert.equal(status.branchDependency, "T003");
  assert.equal(status.reason, "needs shared API first");
});

test("buildQaInstruction includes the QA marker spec", () => {
  const text = buildQaInstruction();
  assert.ok(text.includes("STEP_STATUS: qa_pass"));
  assert.ok(text.includes("STEP_STATUS: qa_fail"));
  assert.ok(text.includes("Triple-check"));
});

test("buildQaFixInstruction embeds the reported issues", () => {
  const text = buildQaFixInstruction("- foo broke\n- bar wrong");
  assert.ok(text.includes("- foo broke"));
  assert.ok(text.includes("- bar wrong"));
  assert.ok(text.includes("STEP_STATUS: done"));
});

test("buildPrimer anchors turn 1 explicitly to fix off-by-one counting", () => {
  const text = buildPrimer(5);
  assert.ok(text.includes("This is step 1 of 5"));
});

test("recovery instructions pin planning and implementation to one ticket", () => {
  assert.match(buildPlanningTurn(1, undefined, "T002"), /first item must be ticket T002/);
  assert.match(buildPrimer(1, undefined, true, "T002"), /Resume and finish ticket T002 first/);
});
