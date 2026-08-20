import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";
import { program } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rafi-cli-test-"));
}

function tsxBin(projectRoot: string): string {
  const local = join(projectRoot, "node_modules", ".bin", "tsx");
  if (existsSync(local)) return local;
  return join(projectRoot, "..", "..", "node_modules", ".bin", "tsx");
}

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

function commandByPath(names: string[]) {
  let current = program;
  for (const name of names) {
    const next = current.commands.find((candidate) => candidate.name() === name);
    assert.ok(next, `missing command ${names.join(" ")}`);
    current = next;
  }
  return current;
}

function docsHelpBlock(docs: string, heading: string): string {
  const marker = `### \`${heading}\`\n\n\`\`\`text\n`;
  const start = docs.indexOf(marker);
  assert.notEqual(start, -1, `missing docs heading ${heading}`);
  const contentStart = start + marker.length;
  const end = docs.indexOf("\n```", contentStart);
  assert.notEqual(end, -1, `missing docs fence for ${heading}`);
  return docs.slice(contentStart, end).trimEnd();
}

function installReadyClaude(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const claudePath = join(binDir, "claude");
  writeFileSync(claudePath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(claudePath, 0o755);
}

function writeSdkPackage(projectDir: string): void {
  const packageDir = join(projectDir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", exports: "./index.js" }),
    "utf8",
  );
  writeFileSync(join(packageDir, "index.js"), "export {};\n", "utf8");
}

test("docs/cli.md matches Commander help for changed rafi surfaces", { skip: nodeMajor < 20 ? "CLI dependencies require Node 20+" : false }, () => {
  const docs = readFileSync(join(HERE, "..", "..", "..", "docs", "cli.md"), "utf8");
  const cases = [
    { heading: "rafi --help", command: program },
    { heading: "rafi plan --help", command: commandByPath(["plan"]) },
    { heading: "rafi tickets plan --help", command: commandByPath(["tickets", "plan"]) },
    { heading: "rafi tickets init --help", command: commandByPath(["tickets", "init"]) },
    { heading: "rafi tickets populate --help", command: commandByPath(["tickets", "populate"]) },
    { heading: "rafi tickets queue --help", command: commandByPath(["tickets", "queue"]) },
  ];

  for (const item of cases) {
    assert.equal(item.command.helpInformation().trimEnd(), docsHelpBlock(docs, item.heading), item.heading);
  }
});

test("status discovers nested projects while explicit paths are exact", { skip: nodeMajor < 20 ? "CLI dependencies require Node 20+" : false }, () => {
  const root = tempDir();
  const nested = join(root, "packages", "web");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, "rafi-config.yaml"), stringify(buildProjectConfig({ ...defaultAnswers(), appName: "Status App" })), "utf8");
  mkdirSync(join(root, ".foreman"));
  writeFileSync(join(root, ".foreman", "2026.jsonl"), `${JSON.stringify({ event: "batch-end", outcome: "completed", completed: 1, requested: 1 })}\n`, "utf8");
  const projectRoot = join(HERE, "..");
  const entry = join(projectRoot, "src", "index.ts");
  const output = execFileSync(tsxBin(projectRoot), [entry, "status"], { cwd: nested, encoding: "utf8" });
  assert.match(output, /rafi: project Status App/);
  assert.match(output, new RegExp(`rafi: root ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(output, /foreman: outcome — completed/);

  const explicit = spawnSync(tsxBin(projectRoot), [entry, "status", nested], { cwd: projectRoot, encoding: "utf8" });
  assert.notEqual(explicit.status, 0);
  assert.match(explicit.stderr, /explicit project directory/);
});

test("compile migrates legacy project.yaml to normalized rafi-config.yaml", { skip: nodeMajor < 20 ? "CLI dependencies require Node 20+" : false }, () => {
  const dir = tempDir();
  const { agent_files, agents, skills, ...legacy } = buildProjectConfig(defaultAnswers());
  void agent_files;
  void agents;
  void skills;
  writeFileSync(join(dir, "project.yaml"), stringify(legacy), "utf8");

  const projectRoot = join(HERE, "..");
  const output = execFileSync(tsxBin(projectRoot), ["src/index.ts", "compile", dir], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.match(output, /migrated project\.yaml to rafi-config\.yaml/);
  assert.ok(existsSync(join(dir, "rafi-config.yaml")));
  assert.ok(existsSync(join(dir, "AGENTS.md")));
  assert.ok(existsSync(join(dir, ".claude", "agents", "builder.md")));

  const config = readFileSync(join(dir, "rafi-config.yaml"), "utf8");
  assert.match(config, /agent_files:/);
  assert.match(config, /artifact_source: rafi/);
  assert.match(config, /agents:/);
  assert.match(config, /skills:/);
});

test("compile --root-file-mode append overrides update mode for the run", { skip: nodeMajor < 20 ? "CLI dependencies require Node 20+" : false }, () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), useClaude: false });
  config.agent_files.mode = "update";
  writeFileSync(join(dir, "rafi-config.yaml"), stringify(config), "utf8");
  writeFileSync(join(dir, "AGENTS.md"), "CUSTOM RULES\n", "utf8");

  const projectRoot = join(HERE, "..");
  execFileSync(tsxBin(projectRoot), ["src/index.ts", "compile", dir, "--root-file-mode", "append"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(content.startsWith("CUSTOM RULES\n"));
  assert.ok(content.includes("<!-- rafi:start -->"));
  assert.match(readFileSync(join(dir, "rafi-config.yaml"), "utf8"), /mode: update/);
});

test("create skips a resolvable Claude Agent SDK", { skip: nodeMajor < 20 ? "CLI dependencies require Node 20+" : false }, () => {
  const dir = tempDir();
  const binDir = join(dir, "bin");
  installReadyClaude(binDir);
  writeSdkPackage(dir);

  const projectRoot = join(HERE, "..");
  const output = execFileSync(
    tsxBin(projectRoot),
    ["src/index.ts", "create", dir, "--defaults", "--runtime", "claude"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    },
  );

  assert.match(output, /Claude Agent SDK already installed; skipping\./);
  assert.doesNotMatch(output, /installing Claude Agent SDK/);
});
