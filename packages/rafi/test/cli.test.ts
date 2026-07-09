import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";

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
