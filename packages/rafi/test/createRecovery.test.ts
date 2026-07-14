import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeUpdateError } from "../src/compiler.js";
import { compileWithRootUpdateRecovery, type RootUpdateRecoveryChoice } from "../src/createRecovery.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rafi-create-recovery-test-"));
}

function withPath(path: string, fn: () => Promise<void> | void): Promise<void> {
  const originalPath = process.env.PATH;
  process.env.PATH = path;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.PATH = originalPath;
    });
}

function installFlakyCodex(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const countPath = join(binDir, "count");
  const script = [
    "#!/bin/sh",
    `count='${countPath}'`,
    "n=0",
    "[ -f \"$count\" ] && n=$(/bin/cat \"$count\")",
    "n=$((n + 1))",
    "echo \"$n\" > \"$count\"",
    "if [ \"$n\" = \"1\" ]; then",
    "  echo '401 Invalid authentication credentials' >&2",
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  const codexPath = join(binDir, "codex");
  writeFileSync(codexPath, script, "utf8");
  chmodSync(codexPath, 0o755);
}

function installCodexOkClaudeFail(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const codexPath = join(binDir, "codex");
  writeFileSync(codexPath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(codexPath, 0o755);

  const claudePath = join(binDir, "claude");
  writeFileSync(claudePath, "#!/bin/sh\necho '401 Invalid authentication credentials' >&2\nexit 1\n", "utf8");
  chmodSync(claudePath, 0o755);
}

test("create recovery retries update and completes when runtime auth is fixed", async () => {
  const dir = tempDir();
  const binDir = join(dir, "bin");
  installFlakyCodex(binDir);
  const config = buildProjectConfig({ ...defaultAnswers(), useClaude: false });
  config.agent_files.mode = "update";
  writeFileSync(join(dir, "AGENTS.md"), "CUSTOM RULES\n", "utf8");

  let prompts = 0;
  await withPath(binDir, async () => {
    const result = await compileWithRootUpdateRecovery(
      dir,
      config,
      {},
      async (err: RuntimeUpdateError): Promise<RootUpdateRecoveryChoice> => {
        prompts += 1;
        assert.match(err.message, /401 Invalid authentication credentials/);
        return "retry";
      },
    );
    assert.equal(result.agent_files.mode, "update");
  });

  assert.equal(prompts, 1);
  assert.ok(existsSync(join(dir, ".rafi", "compiled", "builder", "system.md")));
});

test("create recovery can switch runtime targets when root update auth fails", async () => {
  const dir = tempDir();
  const binDir = join(dir, "bin");
  installCodexOkClaudeFail(binDir);
  const config = buildProjectConfig(defaultAnswers());
  config.agent_files.mode = "update";
  writeFileSync(join(dir, "AGENTS.md"), "CUSTOM CODEX RULES\n", "utf8");
  writeFileSync(join(dir, "CLAUDE.md"), "CUSTOM CLAUDE RULES\n", "utf8");

  await withPath(binDir, async () => {
    const result = await compileWithRootUpdateRecovery(
      dir,
      config,
      {},
      async (err: RuntimeUpdateError): Promise<RootUpdateRecoveryChoice> => {
        assert.equal(err.runtime, "claude");
        assert.match(err.message, /401 Invalid authentication credentials/);
        return "switch";
      },
    );
    assert.deepEqual(result.harness.targets, ["codex"]);
  });

  assert.deepEqual(config.harness.targets, ["claude", "codex"]);
});

test("create recovery can append instead and preserve the existing root file", async () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), useClaude: false });
  config.agent_files.mode = "update";
  writeFileSync(join(dir, "AGENTS.md"), "CUSTOM RULES\n", "utf8");

  await withPath("", async () => {
    const result = await compileWithRootUpdateRecovery(dir, config, {}, async () => "append");
    assert.equal(result.agent_files.mode, "append");
  });

  const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(content.startsWith("CUSTOM RULES\n"));
  assert.ok(content.includes("<!-- rafi:start -->"));
  assert.equal(config.agent_files.mode, "update");
});

test("create recovery append choice uses sidecar behavior for oversized root files", async () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), useClaude: false });
  config.agent_files.mode = "update";
  writeFileSync(join(dir, "AGENTS.md"), `CUSTOM RULES\n${"A".repeat(2_000)}\n`, "utf8");

  await withPath("", async () => {
    const result = await compileWithRootUpdateRecovery(dir, config, {}, async () => "append");
    assert.equal(result.agent_files.mode, "append");
  });

  const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(content.startsWith("<!-- rafi:start -->"));
  assert.ok(content.includes("@AGENTS-rafi.md"));
  assert.ok(content.includes("CUSTOM RULES"));
  assert.ok(existsSync(join(dir, "AGENTS-rafi.md")));
  assert.equal(config.agent_files.mode, "update");
});

test("create recovery can overwrite instead and replace the existing root file", async () => {
  const dir = tempDir();
  const config = buildProjectConfig({ ...defaultAnswers(), useClaude: false });
  config.agent_files.mode = "update";
  writeFileSync(join(dir, "AGENTS.md"), "CUSTOM RULES\n", "utf8");

  await withPath("", async () => {
    const result = await compileWithRootUpdateRecovery(dir, config, {}, async () => "overwrite");
    assert.equal(result.agent_files.mode, "overwrite");
  });

  const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(!content.includes("CUSTOM RULES"));
  assert.ok(content.startsWith("# rafi:"));
  assert.equal(config.agent_files.mode, "update");
});
