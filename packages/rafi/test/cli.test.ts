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

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

test("compile migrates legacy project.yaml to normalized rafi-config.yaml", { skip: nodeMajor < 20 ? "CLI dependencies require Node 20+" : false }, () => {
  const dir = tempDir();
  const { agent_files, agents, skills, ...legacy } = buildProjectConfig(defaultAnswers());
  void agent_files;
  void agents;
  void skills;
  writeFileSync(join(dir, "project.yaml"), stringify(legacy), "utf8");

  const projectRoot = join(HERE, "..");
  const output = execFileSync(join(projectRoot, "node_modules", ".bin", "tsx"), ["src/index.ts", "compile", dir], {
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
