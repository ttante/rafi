import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNode24Policy } from "./node24-policy.mjs";

test("Node 24 policy rejects workspace, CI and version-manager drift", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-node-policy-"));
  const manifest = major => JSON.stringify({ engines: { node: `${major}.x` } });
  try {
    mkdirSync(join(root, "packages", "fixture"), { recursive: true });
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, "package.json"), manifest(24));
    writeFileSync(join(root, "packages/fixture/package.json"), manifest(24));
    writeFileSync(join(root, ".nvmrc"), "24\n");
    const workflow = "matrix:\n  node: [24]\nnode-version: ${{ matrix.node }}\n";
    writeFileSync(join(root, ".github/workflows/build-recovery.yml"), workflow);
    assert.doesNotThrow(() => assertNode24Policy(root));
    writeFileSync(join(root, "packages/fixture/package.json"), manifest(22));
    assert.throws(() => assertNode24Policy(root), /engine drift/);
    writeFileSync(join(root, "packages/fixture/package.json"), manifest(24));
    writeFileSync(join(root, ".nvmrc"), "22\n");
    assert.throws(() => assertNode24Policy(root), /version-manager drift/);
    writeFileSync(join(root, ".nvmrc"), "24\n");
    writeFileSync(join(root, ".github/workflows/build-recovery.yml"), workflow.replace("[24]", "[22]"));
    assert.throws(() => assertNode24Policy(root), /CI drift/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
