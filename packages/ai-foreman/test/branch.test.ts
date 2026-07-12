import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { BuilderAdapter, BuilderEvent, TurnResult } from "../src/adapters/types.js";
import { runBranchPlan } from "../src/branch/runner.js";
import { buildDoctorCommand } from "../src/cli/doctor.js";
import { buildStartCommand } from "../src/cli/start.js";
import { buildStatusCommand } from "../src/cli/status.js";
import { Log } from "../src/log.js";
import { buildBranchPlan, parseAuditDependencies } from "../src/branch/planner.js";
import { checkGitHubReadiness, createOrReusePr, pushBranchForPr } from "../src/branch/github.js";
import {
  findResumableBranchSessions,
  formatBranchContinueCommand,
  formatBranchSummaryFollowupCommands,
} from "../src/branch/resume.js";
import {
  ensureCleanBaseWorktree,
  generatedTrackerDirtyPaths,
} from "../src/branch/git.js";
import type { BranchPlanNode } from "../src/branch/types.js";
import { cmdInit } from "../src/tickets/commands.js";
import { StateDb } from "../src/tickets/stateDb.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import { saveTickets } from "../src/tickets/ticketLoader.js";

function makeDef(id: string, order: number, overrides: Partial<TicketDef> = {}): TicketDef {
  return {
    id,
    order,
    title: `Ticket ${id}`,
    area: "Platform",
    priority: "P1",
    size: "S",
    risk: "Low",
    depends_on: [],
    summary: `Summary for ${id}`,
    acceptance: ["It works"],
    required_tests: ["Unit test"],
    likely_files: ["src/*"],
    rollback: null,
    notes: null,
    ...overrides,
  };
}

class FakeBuilder implements BuilderAdapter {
  readonly agent = "codex" as const;
  private turnCount = 0;

  constructor(
    private readonly cwd: string,
    private readonly id = "sess-test",
    private readonly writeOnFirstTurn = true,
  ) {}

  async sendTurn(_text: string): Promise<TurnResult> {
    this.turnCount++;
    if (this.writeOnFirstTurn && this.turnCount === 1) {
      mkdirSync(join(this.cwd, "src"), { recursive: true });
      writeFileSync(join(this.cwd, "src", "ticket.txt"), `turn ${this.turnCount}\n`, "utf8");
    }
    return {
      text: 'Implemented.\nSTEP_STATUS: done | summary="implemented"',
      isError: false,
      numTurns: 1,
      costUsd: 0,
    };
  }

  sessionId(): string | undefined {
    return this.id;
  }

  async *events(): AsyncIterable<BuilderEvent> {
    return;
  }

  async close(): Promise<void> {}
}

class ExitError extends Error {
  constructor(readonly code: string | number | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeExecutable(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  chmodSync(path, 0o755);
}

function initGitRepo(rootPrefix: string): { root: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), rootPrefix));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  git(project, ["init"]);
  git(project, ["checkout", "-b", "main"]);
  git(project, ["config", "user.email", "foreman-test@example.test"]);
  git(project, ["config", "user.name", "Foreman Test"]);
  writeFileSync(join(project, "README.md"), "# Test\n", "utf8");
  git(project, ["add", "README.md"]);
  git(project, ["commit", "-m", "initial"]);
  return { root, project };
}

function initTicketGitRepo(rootPrefix: string): {
  root: string;
  project: string;
  ticket: TicketDef;
  allowedBaseDirtyPaths: string[];
} {
  const repo = initGitRepo(rootPrefix);
  const ticket = makeDef("T001", 1000);
  cmdInit(repo.project, {});
  saveTickets(join(repo.project, ".tickets", "tickets.yaml"), [ticket]);
  git(repo.project, [
    "add",
    ".tickets/config.yaml",
    ".tickets/tickets.yaml",
    ".tickets/tracker-rules.md",
    ".tickets/schema",
    ".tickets/migrations",
  ]);
  git(repo.project, ["commit", "-m", "add tickets"]);

  return {
    ...repo,
    ticket,
    allowedBaseDirtyPaths: generatedTrackerDirtyPaths({
      stateDb: ".tickets/ticket-state.sqlite",
      progressDoc: "docs/ticket-progress.md",
    }),
  };
}

function makeNode(ticket: TicketDef): BranchPlanNode {
  return {
    ticket,
    branch: `rafi/${ticket.id.toLowerCase()}-ticket`,
    baseRef: "main",
    baseBranch: "main",
    dependencies: [],
    depth: 1,
  };
}

test("branch planner includes later tickets unblocked by earlier selected tickets", () => {
  const plan = buildBranchPlan([
    makeDef("T003", 3000),
    makeDef("T010", 10000, { depends_on: ["T003"] }),
  ], new Map(), {
    steps: 2,
    baseRef: "main",
    branchPrefix: "rafi",
    maxBranchDepth: 2,
  });

  assert.deepEqual(plan.nodes.map((node) => node.ticket.id), ["T003", "T010"]);
  assert.equal(plan.nodes[0].baseBranch, "main");
  assert.equal(plan.nodes[1].baseBranch, plan.nodes[0].branch);
  assert.deepEqual(plan.issues, []);
});

test("branch planner keeps independent tickets rooted at the run base", () => {
  const plan = buildBranchPlan([
    makeDef("T001", 1000),
    makeDef("T002", 2000),
  ], new Map(), {
    steps: 2,
    baseRef: "main",
    branchPrefix: "rafi",
    maxBranchDepth: 2,
  });

  assert.equal(plan.nodes[0].baseBranch, "main");
  assert.equal(plan.nodes[1].baseBranch, "main");
});

test("branch planner accepts audit-added selected-ticket dependencies", () => {
  const plan = buildBranchPlan([
    makeDef("T001", 1000),
    makeDef("T002", 2000),
  ], new Map(), {
    steps: 2,
    baseRef: "main",
    branchPrefix: "rafi",
    maxBranchDepth: 2,
    auditDependencies: [{ ticket: "T002", dependsOn: "T001" }],
  });

  assert.deepEqual(plan.nodes[1].dependencies, ["T001"]);
  assert.equal(plan.nodes[1].baseBranch, plan.nodes[0].branch);
});

test("branch planner reports cycles and depth issues", () => {
  const plan = buildBranchPlan([
    makeDef("T001", 1000),
    makeDef("T002", 2000),
    makeDef("T003", 3000),
  ], new Map(), {
    steps: 3,
    baseRef: "main",
    branchPrefix: "rafi",
    maxBranchDepth: 1,
    auditDependencies: [
      { ticket: "T001", dependsOn: "T003" },
      { ticket: "T003", dependsOn: "T001" },
      { ticket: "T003", dependsOn: "T002" },
    ],
  });

  assert.ok(plan.issues.some((issue) => issue.code === "cycle"));
  assert.ok(plan.issues.some((issue) => issue.code === "depth_exceeded"));
});

test("branch planner blocks acyclic multi-root joins", () => {
  const plan = buildBranchPlan([
    makeDef("T001", 1000),
    makeDef("T002", 2000),
    makeDef("T003", 3000, { depends_on: ["T001", "T002"] }),
  ], new Map(), {
    steps: 3,
    baseRef: "main",
    branchPrefix: "rafi",
    maxBranchDepth: 2,
  });

  assert.ok(plan.issues.some((issue) => issue.code === "multi_root_join"));
});

test("branch planner creates unique slugs", () => {
  const plan = buildBranchPlan([
    makeDef("T001", 1000, { title: "Same Title" }),
    makeDef("T001-copy", 2000, { title: "Same Title" }),
  ], new Map(), {
    steps: 2,
    baseRef: "main",
    branchPrefix: "rafi",
    maxBranchDepth: 2,
  });

  assert.notEqual(plan.nodes[0].branch, plan.nodes[1].branch);
});

test("parseAuditDependencies accepts common audit line forms", () => {
  assert.deepEqual(parseAuditDependencies("T010 depends_on T003 - shared API"), [
    { ticket: "T010", dependsOn: "T003", reason: "T010 depends_on T003 - shared API" },
  ]);
  assert.deepEqual(parseAuditDependencies("T010 after T003"), [
    { ticket: "T010", dependsOn: "T003", reason: "T010 after T003" },
  ]);
});

test("ensureCleanBaseWorktree allows only generated tracker runtime files", () => {
  const { root, project, allowedBaseDirtyPaths } = initTicketGitRepo("foreman-clean-test-");
  try {
    writeFileSync(join(project, ".tickets", "ticket-state.sqlite"), "db changed\n", "utf8");
    writeFileSync(join(project, ".tickets", "ticket-state.sqlite-wal"), "wal\n", "utf8");
    writeFileSync(join(project, ".tickets", "ticket-state.sqlite-shm"), "shm\n", "utf8");
    writeFileSync(join(project, "docs", "ticket-progress.md"), "generated progress changed\n", "utf8");

    assert.doesNotThrow(() => ensureCleanBaseWorktree(project, { allowedDirtyPaths: allowedBaseDirtyPaths }));

    writeFileSync(join(project, ".tickets", "tickets.yaml"), "tickets: []\n", "utf8");
    assert.throws(
      () => ensureCleanBaseWorktree(project, { allowedDirtyPaths: allowedBaseDirtyPaths }),
      /base worktree has uncommitted changes:[\s\S]*\.tickets\/tickets\.yaml/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generatedTrackerDirtyPaths includes configured archive docs and temp files", () => {
  assert.deepEqual(
    generatedTrackerDirtyPaths({
      stateDb: ".tickets/ticket-state.sqlite",
      progressDoc: "docs-rafi/ticket-progress.md",
      archiveDoc: "docs-rafi/ticket-archive.md",
    }),
    [
      ".tickets/ticket-state.sqlite",
      ".tickets/ticket-state.sqlite-wal",
      ".tickets/ticket-state.sqlite-shm",
      "docs-rafi/ticket-progress.md",
      "docs-rafi/ticket-progress.md.tmp",
      "docs-rafi/ticket-archive.md",
      "docs-rafi/ticket-archive.md.tmp",
    ],
  );
});

test("GitHub readiness classifies missing gh", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-gh-missing-test-"));
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = dir;
    const result = checkGitHubReadiness(dir);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "gh_missing");
      assert.match(result.repairCommands.join("\n"), /gh --version/);
    }
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitHub readiness classifies auth, remote, repo, git, and timeout failures", () => {
  const oldPath = process.env.PATH;
  const oldTimeout = process.env.RAFI_GITHUB_COMMAND_TIMEOUT_MS;
  const cases: Array<{
    name: string;
    gh: string[];
    git: string[];
    code: string;
    timeout?: string;
  }> = [
    {
      name: "missing remote",
      code: "remote_missing",
      gh: [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"--version\" ]; then echo 'gh version test'; exit 0; fi",
        "exit 0",
      ],
      git: [
        "#!/usr/bin/env bash",
        "if [ \"$1 $2 $3\" = \"remote get-url origin\" ]; then echo 'missing origin' >&2; exit 1; fi",
        "exit 2",
      ],
    },
    {
      name: "non github remote",
      code: "remote_not_github",
      gh: [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"--version\" ]; then echo 'gh version test'; exit 0; fi",
        "exit 0",
      ],
      git: [
        "#!/usr/bin/env bash",
        "if [ \"$1 $2 $3\" = \"remote get-url origin\" ]; then echo 'git@gitlab.com:owner/repo.git'; exit 0; fi",
        "exit 2",
      ],
    },
    {
      name: "auth failure",
      code: "gh_not_authenticated",
      gh: [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"--version\" ]; then echo 'gh version test'; exit 0; fi",
        "if [ \"$1 $2\" = \"auth status\" ]; then echo 'not logged in' >&2; exit 1; fi",
        "exit 2",
      ],
      git: [
        "#!/usr/bin/env bash",
        "if [ \"$1 $2 $3\" = \"remote get-url origin\" ]; then echo 'git@github.com:owner/repo.git'; exit 0; fi",
        "exit 2",
      ],
    },
    {
      name: "repo view failure",
      code: "repo_unreachable",
      gh: [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"--version\" ]; then echo 'gh version test'; exit 0; fi",
        "if [ \"$1 $2\" = \"auth status\" ]; then exit 0; fi",
        "if [ \"$1 $2\" = \"repo view\" ]; then echo 'not found' >&2; exit 1; fi",
        "exit 2",
      ],
      git: [
        "#!/usr/bin/env bash",
        "if [ \"$1 $2 $3\" = \"remote get-url origin\" ]; then echo 'git@github.com:owner/repo.git'; exit 0; fi",
        "exit 2",
      ],
    },
    {
      name: "git remote failure",
      code: "git_remote_unreachable",
      gh: [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"--version\" ]; then echo 'gh version test'; exit 0; fi",
        "if [ \"$1 $2\" = \"auth status\" ]; then exit 0; fi",
        "if [ \"$1 $2\" = \"repo view\" ]; then echo 'owner/repo'; exit 0; fi",
        "exit 2",
      ],
      git: [
        "#!/usr/bin/env bash",
        "if [ \"$1 $2 $3\" = \"remote get-url origin\" ]; then echo 'git@github.com:owner/repo.git'; exit 0; fi",
        "if [ \"$1 $2\" = \"ls-remote origin\" ]; then echo 'fatal: unreachable' >&2; exit 1; fi",
        "exit 2",
      ],
    },
    {
      name: "repo view timeout",
      code: "network_or_timeout",
      timeout: "50",
      gh: [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"--version\" ]; then echo 'gh version test'; exit 0; fi",
        "if [ \"$1 $2\" = \"auth status\" ]; then exit 0; fi",
        "if [ \"$1 $2\" = \"repo view\" ]; then sleep 1; exit 0; fi",
        "exit 2",
      ],
      git: [
        "#!/usr/bin/env bash",
        "if [ \"$1 $2 $3\" = \"remote get-url origin\" ]; then echo 'git@github.com:owner/repo.git'; exit 0; fi",
        "if [ \"$1 $2\" = \"ls-remote origin\" ]; then echo 'abc refs/heads/main'; exit 0; fi",
        "exit 2",
      ],
    },
  ];

  try {
    for (const item of cases) {
      const dir = mkdtempSync(join(tmpdir(), `foreman-gh-${item.name.replace(/\s+/g, "-")}-`));
      const binDir = join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeExecutable(join(binDir, "gh"), item.gh);
      writeExecutable(join(binDir, "git"), item.git);
      process.env.PATH = `${binDir}:${oldPath}`;
      if (item.timeout) process.env.RAFI_GITHUB_COMMAND_TIMEOUT_MS = item.timeout;
      else delete process.env.RAFI_GITHUB_COMMAND_TIMEOUT_MS;

      const result = checkGitHubReadiness(dir);
      assert.equal(result.ok, false, item.name);
      if (!result.ok) assert.equal(result.code, item.code, item.name);
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env.RAFI_GITHUB_COMMAND_TIMEOUT_MS;
    else process.env.RAFI_GITHUB_COMMAND_TIMEOUT_MS = oldTimeout;
  }
});

test("GitHub readiness distinguishes gh repository, DNS, non-GitHub host, and GHE failures", () => {
  const oldPath = process.env.PATH;
  const dirs: string[] = [];
  const cases: Array<{
    name: string;
    remote: string;
    gh: string[];
    code: string;
    repairPattern?: RegExp;
  }> = [
    {
      name: "gh repository resolution",
      remote: "git@github.com:owner/repo.git",
      code: "repo_unreachable",
      gh: [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"--version\" ]; then echo 'gh version test'; exit 0; fi",
        "if [ \"$1 $2\" = \"auth status\" ]; then exit 0; fi",
        "if [ \"$1 $2\" = \"repo view\" ]; then echo 'GraphQL: Could not resolve to a Repository with the name owner/repo.' >&2; exit 1; fi",
        "exit 2",
      ],
    },
    {
      name: "dns resolution",
      remote: "git@github.com:owner/repo.git",
      code: "network_or_timeout",
      gh: [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"--version\" ]; then echo 'gh version test'; exit 0; fi",
        "if [ \"$1 $2\" = \"auth status\" ]; then exit 0; fi",
        "if [ \"$1 $2\" = \"repo view\" ]; then echo 'fatal: unable to access https://github.com/owner/repo: Could not resolve host: github.com' >&2; exit 1; fi",
        "exit 2",
      ],
    },
    {
      name: "unknown non github host",
      remote: "git@git.example.test:owner/repo.git",
      code: "remote_not_github",
      repairPattern: /gh auth login --hostname git\.example\.test/,
      gh: [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"--version\" ]; then echo 'gh version test'; exit 0; fi",
        "if [ \"$1 $2\" = \"auth status\" ]; then echo 'git.example.test is not a GitHub host' >&2; exit 1; fi",
        "exit 2",
      ],
    },
    {
      name: "ghe auth failure",
      remote: "git@ghe.example.test:owner/repo.git",
      code: "gh_not_authenticated",
      repairPattern: /gh auth status --hostname ghe\.example\.test/,
      gh: [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"--version\" ]; then echo 'gh version test'; exit 0; fi",
        "if [ \"$1 $2\" = \"auth status\" ]; then echo 'not logged in' >&2; exit 1; fi",
        "exit 2",
      ],
    },
  ];

  try {
    for (const item of cases) {
      const dir = mkdtempSync(join(tmpdir(), `foreman-gh-specific-${item.name.replace(/\s+/g, "-")}-`));
      dirs.push(dir);
      const binDir = join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeExecutable(join(binDir, "gh"), item.gh);
      writeExecutable(join(binDir, "git"), [
        "#!/usr/bin/env bash",
        `if [ "$1 $2 $3" = "remote get-url origin" ]; then echo '${item.remote}'; exit 0; fi`,
        "if [ \"$1 $2\" = \"ls-remote origin\" ]; then echo 'abc refs/heads/main'; exit 0; fi",
        "exit 2",
      ]);
      process.env.PATH = `${binDir}:${oldPath}`;

      const result = checkGitHubReadiness(dir);
      assert.equal(result.ok, false, item.name);
      if (!result.ok) {
        assert.equal(result.code, item.code, item.name);
        if (item.repairPattern) assert.match(result.repairCommands.join("\n"), item.repairPattern, item.name);
      }
    }
  } finally {
    process.env.PATH = oldPath;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test("push and PR creation failures return structured GitHub failure codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-gh-structured-test-"));
  const binDir = join(dir, "bin");
  const oldPath = process.env.PATH;
  try {
    mkdirSync(binDir, { recursive: true });
    writeExecutable(join(binDir, "git"), [
      "#!/usr/bin/env bash",
      "if [ \"$1\" = \"push\" ]; then echo 'permission denied' >&2; exit 1; fi",
      "exit 2",
    ]);
    process.env.PATH = `${binDir}:${oldPath}`;
    const push = pushBranchForPr(dir, "rafi/t001-ticket");
    assert.equal(push.ok, false);
    if (!push.ok) {
      assert.equal(push.code, "push_failed");
      assert.match(push.repairCommands.join("\n"), /git push -u origin rafi\/t001-ticket/);
    }

    writeExecutable(join(binDir, "gh"), [
      "#!/usr/bin/env bash",
      "if [ \"$1 $2\" = \"pr list\" ]; then exit 0; fi",
      "if [ \"$1 $2\" = \"pr create\" ]; then echo 'PR failed' >&2; exit 1; fi",
      "exit 0",
    ]);
    const node = makeNode(makeDef("T001", 1000));
    const pr = createOrReusePr(dir, { node, ready: false, runId: "run" });
    assert.equal(pr.status, "failed");
    assert.equal(pr.code, "pr_create_failed");
    assert.match(pr.repairCommands?.join("\n") ?? "", /gh pr list --head rafi\/t001-ticket/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createOrReusePr returns a structured failure when PR body cannot be written", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-pr-body-write-test-"));
  const binDir = join(dir, "bin");
  const oldPath = process.env.PATH;
  try {
    mkdirSync(binDir, { recursive: true });
    writeExecutable(join(binDir, "gh"), [
      "#!/usr/bin/env bash",
      "if [ \"$1 $2\" = \"pr list\" ]; then exit 0; fi",
      "if [ \"$1 $2\" = \"pr create\" ]; then echo 'should not create PR' >&2; exit 1; fi",
      "exit 0",
    ]);
    mkdirSync(join(dir, ".foreman"), { recursive: true });
    writeFileSync(join(dir, ".foreman", "pr-bodies"), "not a directory\n", "utf8");
    process.env.PATH = `${binDir}:${oldPath}`;

    const node = makeNode(makeDef("T001", 1000));
    const pr = createOrReusePr(dir, { node, ready: false, runId: "run" });

    assert.equal(pr.status, "failed");
    assert.equal(pr.code, "pr_create_failed");
    assert.match(pr.message ?? "", /Failed to write GitHub PR body file/);
    assert.match(pr.output ?? "", /ENOTDIR|not a directory|EEXIST/);
    assert.match(pr.repairCommands?.join("\n") ?? "", /\.foreman\/pr-bodies/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createOrReusePr includes GitHub Enterprise repair commands for PR failures", () => {
  const { root, project } = initGitRepo("foreman-pr-ghe-repair-test-");
  const binDir = join(root, "bin");
  const oldPath = process.env.PATH;
  try {
    git(project, ["remote", "add", "origin", "git@ghe.example.test:owner/repo.git"]);
    mkdirSync(binDir, { recursive: true });
    writeExecutable(join(binDir, "gh"), [
      "#!/usr/bin/env bash",
      "if [ \"$1 $2\" = \"pr list\" ]; then exit 0; fi",
      "if [ \"$1 $2\" = \"pr create\" ]; then echo 'PR failed' >&2; exit 1; fi",
      "exit 0",
    ]);
    process.env.PATH = `${binDir}:${oldPath}`;

    const node = makeNode(makeDef("T001", 1000));
    const pr = createOrReusePr(project, { node, ready: false, runId: "run" });

    assert.equal(pr.status, "failed");
    assert.equal(pr.code, "pr_create_failed");
    assert.match(pr.repairCommands?.join("\n") ?? "", /gh auth login --hostname ghe\.example\.test/);
    assert.match(pr.repairCommands?.join("\n") ?? "", /gh repo view ghe\.example\.test\/owner\/repo/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("createOrReusePr defaults to draft and omits draft when ready", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-gh-test-"));
  const logPath = join(dir, "gh.log");
  const oldPath = process.env.PATH;
  const oldGhLog = process.env.GH_LOG;
  try {
    writeFileSync(logPath, "", "utf8");
    writeFileSync(join(dir, "gh"), [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"$*\" >> \"$GH_LOG\"",
      "if [ \"$1 $2\" = \"pr list\" ]; then exit 0; fi",
      "if [ \"$1 $2\" = \"pr create\" ]; then echo 'https://example.test/pr/1'; fi",
      "",
    ].join("\n"), "utf8");
    chmodSync(join(dir, "gh"), 0o755);
    process.env.PATH = `${dir}:${oldPath}`;
    process.env.GH_LOG = logPath;

    const node: BranchPlanNode = {
      ticket: makeDef("T001", 1000),
      branch: "rafi/t001-ticket",
      baseRef: "main",
      baseBranch: "main",
      dependencies: [],
      depth: 1,
    };

    assert.equal(createOrReusePr(dir, { node, ready: false, runId: "run" }).status, "created");
    assert.match(readFileSync(logPath, "utf8"), /--draft/);

    writeFileSync(logPath, "", "utf8");
    assert.equal(createOrReusePr(dir, { node, ready: true, runId: "run2" }).status, "created");
    assert.doesNotMatch(readFileSync(logPath, "utf8"), /--draft/);
  } finally {
    process.env.PATH = oldPath;
    if (oldGhLog === undefined) delete process.env.GH_LOG;
    else process.env.GH_LOG = oldGhLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runBranchPlan blocks the ticket when branch push fails", async () => {
  const { root, project, ticket, allowedBaseDirtyPaths } = initTicketGitRepo("foreman-push-fail-test-");
  const node = makeNode(ticket);
  const logPath = join(project, ".foreman", "push-fail.jsonl");
  try {
    git(project, ["remote", "add", "origin", join(root, "missing-origin.git")]);
    const summaries = await runBranchPlan({
      projectDir: project,
      runId: "run",
      plan: { baseRef: "main", nodes: [node], issues: [] },
      log: new Log(logPath),
      agent: "codex",
      notificationsEnabled: false,
      qaEnabled: false,
      createPr: true,
      prReady: false,
      keepWorktrees: false,
      allowedBaseDirtyPaths,
      createBuilder: async (cwd) => new FakeBuilder(cwd),
    });

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.buildStatus, "blocked");
    assert.equal(summaries[0]?.pushStatus, "failed");
    assert.equal(summaries[0]?.pr?.status, "skipped");
    assert.match(summaries[0]?.detail ?? "", /push failed:/);
    assert.ok(node.worktreePath && existsSync(node.worktreePath), "failed push worktree should be kept");

    const db = new StateDb(join(project, ".tickets", "ticket-state.sqlite"));
    try {
      assert.equal(db.getState("T001")?.status, "blocked");
    } finally {
      db.close();
    }
    const logContent = readFileSync(logPath, "utf8");
    assert.match(logContent, /"code":"push_failed"/);
    assert.doesNotMatch(logContent, /"event":"branch-complete"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBranchPlan blocks the ticket when PR creation fails", async () => {
  const { root, project, ticket, allowedBaseDirtyPaths } = initTicketGitRepo("foreman-pr-fail-test-");
  const remote = join(root, "origin.git");
  const binDir = join(root, "bin");
  const node = makeNode(ticket);
  const logPath = join(project, ".foreman", "pr-fail.jsonl");
  const oldPath = process.env.PATH;
  try {
    execFileSync("git", ["init", "--bare", remote], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(project, ["remote", "add", "origin", remote]);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "gh"), [
      "#!/usr/bin/env bash",
      "if [ \"$1 $2\" = \"pr list\" ]; then exit 0; fi",
      "if [ \"$1 $2\" = \"pr create\" ]; then echo 'PR failed' >&2; exit 1; fi",
      "exit 0",
      "",
    ].join("\n"), "utf8");
    chmodSync(join(binDir, "gh"), 0o755);
    process.env.PATH = `${binDir}:${oldPath}`;

    const summaries = await runBranchPlan({
      projectDir: project,
      runId: "run",
      plan: { baseRef: "main", nodes: [node], issues: [] },
      log: new Log(logPath),
      agent: "codex",
      notificationsEnabled: false,
      qaEnabled: false,
      createPr: true,
      prReady: false,
      keepWorktrees: false,
      allowedBaseDirtyPaths,
      createBuilder: async (cwd) => new FakeBuilder(cwd),
    });

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.buildStatus, "blocked");
    assert.equal(summaries[0]?.pushStatus, "pushed");
    assert.equal(summaries[0]?.pr?.status, "failed");
    assert.match(summaries[0]?.detail ?? "", /PR creation failed:/);
    assert.ok(node.worktreePath && existsSync(node.worktreePath), "failed PR worktree should be kept");

    const db = new StateDb(join(project, ".tickets", "ticket-state.sqlite"));
    try {
      assert.equal(db.getState("T001")?.status, "blocked");
    } finally {
      db.close();
    }
    const logContent = readFileSync(logPath, "utf8");
    assert.match(logContent, /"event":"pr-failed"/);
    assert.match(logContent, /"code":"pr_create_failed"/);
    assert.doesNotMatch(logContent, /"event":"branch-complete"/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBranchPlan blocks the ticket when PR body writing fails after push", async () => {
  const { root, project, ticket, allowedBaseDirtyPaths } = initTicketGitRepo("foreman-pr-body-runner-test-");
  const remote = join(root, "origin.git");
  const binDir = join(root, "bin");
  const node = makeNode(ticket);
  const logPath = join(project, ".foreman", "pr-body-fail.jsonl");
  const oldPath = process.env.PATH;
  try {
    execFileSync("git", ["init", "--bare", remote], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(project, ["remote", "add", "origin", remote]);
    mkdirSync(binDir, { recursive: true });
    writeExecutable(join(binDir, "gh"), [
      "#!/usr/bin/env bash",
      "if [ \"$1 $2\" = \"pr list\" ]; then exit 0; fi",
      "if [ \"$1 $2\" = \"pr create\" ]; then echo 'should not create PR' >&2; exit 1; fi",
      "exit 0",
    ]);
    mkdirSync(join(project, ".foreman"), { recursive: true });
    writeFileSync(join(project, ".foreman", "pr-bodies"), "not a directory\n", "utf8");
    process.env.PATH = `${binDir}:${oldPath}`;

    const summaries = await runBranchPlan({
      projectDir: project,
      runId: "run",
      plan: { baseRef: "main", nodes: [node], issues: [] },
      log: new Log(logPath),
      agent: "codex",
      notificationsEnabled: false,
      qaEnabled: false,
      createPr: true,
      prReady: false,
      keepWorktrees: false,
      allowedBaseDirtyPaths,
      createBuilder: async (cwd) => new FakeBuilder(cwd),
    });

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.buildStatus, "blocked");
    assert.equal(summaries[0]?.pushStatus, "pushed");
    assert.equal(summaries[0]?.pr?.status, "failed");
    assert.equal(summaries[0]?.pr?.code, "pr_create_failed");
    assert.match(summaries[0]?.detail ?? "", /PR creation failed: Failed to write GitHub PR body file/);
    assert.ok(node.worktreePath && existsSync(node.worktreePath), "failed PR body worktree should be kept");

    const db = new StateDb(join(project, ".tickets", "ticket-state.sqlite"));
    try {
      assert.equal(db.getState("T001")?.status, "blocked");
    } finally {
      db.close();
    }
    const logContent = readFileSync(logPath, "utf8");
    assert.match(logContent, /"event":"pr-failed"/);
    assert.match(logContent, /"event":"branch-issue"/);
    assert.match(logContent, /"code":"pr_create_failed"/);
    assert.match(logContent, /"repairCommands":/);
    assert.doesNotMatch(logContent, /"code":"builder_error"/);
    assert.doesNotMatch(logContent, /"event":"branch-complete"/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBranchPlan reuses an existing branch commit when retrying PR creation", async () => {
  const { root, project, ticket, allowedBaseDirtyPaths } = initTicketGitRepo("foreman-pr-retry-test-");
  const remote = join(root, "origin.git");
  const binDir = join(root, "bin");
  const ghPath = join(binDir, "gh");
  const node = makeNode(ticket);
  const oldPath = process.env.PATH;
  try {
    execFileSync("git", ["init", "--bare", remote], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(project, ["remote", "add", "origin", remote]);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(ghPath, [
      "#!/usr/bin/env bash",
      "if [ \"$1 $2\" = \"pr list\" ]; then exit 0; fi",
      "if [ \"$1 $2\" = \"pr create\" ]; then echo 'PR failed' >&2; exit 1; fi",
      "exit 0",
      "",
    ].join("\n"), "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${binDir}:${oldPath}`;

    const first = await runBranchPlan({
      projectDir: project,
      runId: "run",
      plan: { baseRef: "main", nodes: [node], issues: [] },
      log: new Log(join(project, ".foreman", "first-pr-fail.jsonl")),
      agent: "codex",
      notificationsEnabled: false,
      qaEnabled: false,
      createPr: true,
      prReady: false,
      keepWorktrees: false,
      allowedBaseDirtyPaths,
      createBuilder: async (cwd) => new FakeBuilder(cwd, "sess-first"),
    });

    assert.equal(first[0]?.buildStatus, "blocked");
    assert.ok(node.worktreePath && existsSync(node.worktreePath), "first failed PR worktree should remain");
    const retryWorktree = node.worktreePath;
    const retryCommit = first[0]?.commit;
    assert.ok(retryCommit, "first run should have committed implementation changes");

    writeFileSync(ghPath, [
      "#!/usr/bin/env bash",
      "if [ \"$1 $2\" = \"pr list\" ]; then exit 0; fi",
      "if [ \"$1 $2\" = \"pr create\" ]; then echo 'https://example.test/pr/2'; exit 0; fi",
      "exit 0",
      "",
    ].join("\n"), "utf8");
    chmodSync(ghPath, 0o755);

    const retryNode = makeNode(ticket);
    const second = await runBranchPlan({
      projectDir: project,
      runId: "retry",
      plan: { baseRef: "main", nodes: [retryNode], issues: [] },
      log: new Log(join(project, ".foreman", "retry-pr-success.jsonl")),
      agent: "codex",
      notificationsEnabled: false,
      qaEnabled: false,
      createPr: true,
      prReady: false,
      keepWorktrees: false,
      allowedBaseDirtyPaths,
      resumeSessions: new Map([["T001", { worktreePath: retryWorktree, sessionId: "sess-first" }]]),
      createBuilder: async (cwd, sessionId) => new FakeBuilder(cwd, sessionId, false),
    });

    assert.equal(second[0]?.buildStatus, "done");
    assert.equal(second[0]?.commit, retryCommit);
    assert.equal(second[0]?.pushStatus, "pushed");
    assert.equal(second[0]?.pr?.url, "https://example.test/pr/2");

    const db = new StateDb(join(project, ".tickets", "ticket-state.sqlite"));
    try {
      assert.equal(db.getState("T001")?.status, "done");
    } finally {
      db.close();
    }
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("findResumableBranchSessions returns unfinished ticket sessions and command hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-branch-resume-test-"));
  const foremanDir = join(dir, ".foreman");
  const keptWorktree = join(foremanDir, "worktrees", "run", "rafi__t001");
  const doneWorktree = join(foremanDir, "worktrees", "run", "rafi__t002");
  try {
    mkdirSync(keptWorktree, { recursive: true });
    mkdirSync(doneWorktree, { recursive: true });
    writeFileSync(join(foremanDir, "run.jsonl"), [
      JSON.stringify({
        ts: "2026-07-09T00:00:00.000Z",
        event: "branch-session",
        ticket: "T001",
        branch: "rafi/t001-ticket",
        base: "main",
        worktreePath: keptWorktree,
        sessionId: "sess-1",
        agent: "codex",
        model: "gpt-5.5",
        effort: "xhigh",
        fast: true,
        qaEnabled: false,
        createPr: true,
        prReady: true,
        keepWorktrees: true,
      }),
      JSON.stringify({
        ts: "2026-07-09T00:00:01.000Z",
        event: "branch-session",
        ticket: "T002",
        branch: "rafi/t002-ticket",
        base: "main",
        worktreePath: doneWorktree,
        sessionId: "sess-2",
      }),
      JSON.stringify({
        ts: "2026-07-09T00:00:02.000Z",
        event: "branch-complete",
        ticket: "T002",
        branch: "rafi/t002-ticket",
        status: "done",
      }),
      "",
    ].join("\n"), "utf8");

    const sessions = findResumableBranchSessions(foremanDir);
    assert.deepEqual(sessions.map((session) => session.ticket), ["T001"]);
    assert.equal(sessions[0]?.sessionId, "sess-1");
    const command = formatBranchContinueCommand(dir, sessions[0]!);
    assert.match(command, /ai-foreman start .* --steps 1 --create-pr --continue --ticket T001/);
    assert.match(command, /--agent codex/);
    assert.match(command, /--model gpt-5\.5/);
    assert.match(command, /--effort xhigh/);
    assert.match(command, /--fast/);
    assert.match(command, /--no-qa/);
    assert.match(command, /--pr-ready/);
    assert.match(command, /--keep-worktrees/);
    assert.deepEqual(
      formatBranchSummaryFollowupCommands(dir, foremanDir, [
        { ticket: "T001", buildStatus: "blocked" },
        { ticket: "T002", buildStatus: "done" },
      ]),
      [command],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start --create-pr stops before branch planning when GitHub readiness fails", async () => {
  const { root, project } = initTicketGitRepo("foreman-start-gh-preflight-test-");
  const binDir = join(root, "bin");
  const oldPath = process.env.PATH;
  const oldExit = process.exit;
  const oldError = console.error;
  let errorOutput = "";
  try {
    mkdirSync(binDir, { recursive: true });
    writeExecutable(join(binDir, "gh"), [
      "#!/usr/bin/env bash",
      "echo 'gh missing' >&2",
      "exit 127",
    ]);
    process.env.PATH = `${binDir}:${oldPath}`;
    process.exit = ((code?: string | number | null | undefined): never => {
      throw new ExitError(code);
    }) as typeof process.exit;
    console.error = (...args: unknown[]) => {
      errorOutput += `${args.join(" ")}\n`;
    };

    await assert.rejects(
      buildStartCommand().parseAsync([project, "--steps", "1", "--create-pr", "--yes"], { from: "user" }),
      (err: unknown) => err instanceof ExitError && err.code === 1,
    );
    assert.match(errorOutput, /GitHub PR setup failed before building/);
    assert.match(errorOutput, /gh_missing/);

    const foremanDir = join(project, ".foreman");
    const logs = readdirSync(foremanDir).filter((file) => file.endsWith(".jsonl"));
    assert.equal(logs.length, 1);
    const content = readFileSync(join(foremanDir, logs[0]!), "utf8");
    assert.match(content, /"event":"github-readiness-failed"/);
    assert.doesNotMatch(content, /"event":"branch-plan"/);
    assert.doesNotMatch(content, /"event":"branch-session"/);

    const db = new StateDb(join(project, ".tickets", "ticket-state.sqlite"));
    try {
      assert.notEqual(db.getState("T001")?.status, "in_progress");
    } finally {
      db.close();
    }
  } finally {
    process.env.PATH = oldPath;
    process.exit = oldExit;
    console.error = oldError;
    rmSync(root, { recursive: true, force: true });
  }
});

test("status prints latest GitHub failure repair guidance and retry command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-status-gh-fail-test-"));
  const foremanDir = join(dir, ".foreman");
  const worktree = join(foremanDir, "worktrees", "run", "rafi__t001");
  const oldLog = console.log;
  let output = "";
  try {
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(foremanDir, "run.jsonl"), [
      JSON.stringify({
        ts: "2026-07-09T00:00:00.000Z",
        event: "branch-session",
        ticket: "T001",
        branch: "rafi/t001-ticket",
        base: "main",
        worktreePath: worktree,
        sessionId: "sess-1",
        createPr: true,
      }),
      JSON.stringify({
        ts: "2026-07-09T00:00:01.000Z",
        event: "branch-push",
        ticket: "T001",
        branch: "rafi/t001-ticket",
        status: "failed",
        code: "push_failed",
        message: "Failed to push branch rafi/t001-ticket to origin.",
        repairCommands: ["git push -u origin rafi/t001-ticket", "git ls-remote origin"],
        output: "permission denied",
      }),
      JSON.stringify({
        ts: "2026-07-09T00:00:02.000Z",
        event: "branch-issue",
        ticket: "T001",
        code: "push_failed",
        message: "push failed: sparse branch issue",
        blocking: false,
      }),
      "",
    ].join("\n"), "utf8");
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    await buildStatusCommand().parseAsync([dir], { from: "user" });

    assert.match(output, /latest GitHub failure — push_failed/);
    assert.match(output, /git push -u origin rafi\/t001-ticket/);
    assert.match(output, /ai-foreman start .* --create-pr --continue --ticket T001/);
    assert.match(output, /permission denied/);
  } finally {
    console.log = oldLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status keeps rich PR failure guidance when branch issue follows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-status-pr-fail-test-"));
  const foremanDir = join(dir, ".foreman");
  const worktree = join(foremanDir, "worktrees", "run", "rafi__t001");
  const oldLog = console.log;
  let output = "";
  try {
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(foremanDir, "run.jsonl"), [
      JSON.stringify({
        ts: "2026-07-09T00:00:00.000Z",
        event: "branch-session",
        ticket: "T001",
        branch: "rafi/t001-ticket",
        base: "main",
        worktreePath: worktree,
        sessionId: "sess-1",
        createPr: true,
      }),
      JSON.stringify({
        ts: "2026-07-09T00:00:01.000Z",
        event: "pr-failed",
        ticket: "T001",
        branch: "rafi/t001-ticket",
        code: "pr_create_failed",
        message: "Failed to create GitHub PR. Branch: rafi/t001-ticket",
        repairCommands: ["gh pr list --head rafi/t001-ticket --state open", "gh auth status", "gh repo view"],
        output: "PR failed",
      }),
      JSON.stringify({
        ts: "2026-07-09T00:00:02.000Z",
        event: "branch-issue",
        ticket: "T001",
        code: "pr_create_failed",
        message: "PR creation failed: sparse branch issue",
        blocking: false,
      }),
      "",
    ].join("\n"), "utf8");
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    await buildStatusCommand().parseAsync([dir], { from: "user" });

    assert.match(output, /latest GitHub failure — pr_create_failed/);
    assert.match(output, /gh pr list --head rafi\/t001-ticket --state open/);
    assert.match(output, /ai-foreman start .* --create-pr --continue --ticket T001/);
    assert.match(output, /PR failed/);
  } finally {
    console.log = oldLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor --github reports GitHub readiness failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-doctor-gh-test-"));
  const binDir = join(dir, "bin");
  const oldPath = process.env.PATH;
  const oldExit = process.exit;
  const oldLog = console.log;
  let output = "";
  try {
    mkdirSync(binDir, { recursive: true });
    process.env.PATH = binDir;
    process.exit = ((code?: string | number | null | undefined): never => {
      throw new ExitError(code);
    }) as typeof process.exit;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    await assert.rejects(
      buildDoctorCommand().parseAsync([dir, "--github"], { from: "user" }),
      (err: unknown) => err instanceof ExitError && err.code === 1,
    );
    assert.match(output, /!! github PR readiness — gh_missing/);
    assert.match(output, /-- github repair — gh --version/);
  } finally {
    process.env.PATH = oldPath;
    process.exit = oldExit;
    console.log = oldLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start rejects explicit branch resume with multiple tickets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-start-resume-test-"));
  const oldExit = process.exit;
  const oldError = console.error;
  let errorOutput = "";
  try {
    process.exit = ((code?: string | number | null | undefined): never => {
      throw new ExitError(code);
    }) as typeof process.exit;
    console.error = (...args: unknown[]) => {
      errorOutput += `${args.join(" ")}\n`;
    };

    await assert.rejects(
      buildStartCommand().parseAsync([
        dir,
        "--steps",
        "1",
        "--branch-per-ticket",
        "--resume",
        "sess-1",
        "--ticket",
        "T001",
        "--ticket",
        "T002",
      ], { from: "user" }),
      (err: unknown) => err instanceof ExitError && err.code === 1,
    );
    assert.match(errorOutput, /supports exactly one --ticket/);
  } finally {
    process.exit = oldExit;
    console.error = oldError;
    rmSync(dir, { recursive: true, force: true });
  }
});
