/**
 * Guards the shard *generator* (scripts/shard.ts), as opposed to its output:
 *
 *  - determinism: sharding the same snapshot twice yields identical bytes;
 *  - fidelity: the committed packs + packs.index.yaml are exactly what the
 *    generator emits today, so a hand-edit to a pack (instead of editing the
 *    snapshot and re-running) is caught;
 *  - guard rails: the count assertion and unmapped-heading error still fire.
 *
 * Pure-function based (no filesystem writes), so it never mutates the working tree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shard, EXPECTED_PACK_COUNT } from "../scripts/shard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const SNAPSHOT = join(PKG, "test/fixtures/rules.snapshot.md");
const RULES_DIR = join(PKG, "content/rules");
const CONTENT = join(PKG, "content");

const snapshotText = readFileSync(SNAPSHOT, "utf8");

test("shard is deterministic: same input → identical output", () => {
  const a = shard(snapshotText);
  const b = shard(snapshotText);
  assert.deepEqual(a, b);
});

test(`shard emits exactly ${EXPECTED_PACK_COUNT} packs`, () => {
  assert.equal(shard(snapshotText).files.length, EXPECTED_PACK_COUNT);
});

test("committed packs match the generator byte-for-byte", () => {
  const { files } = shard(snapshotText);
  for (const f of files) {
    const onDisk = readFileSync(join(RULES_DIR, f.path), "utf8");
    assert.equal(
      f.content,
      onDisk,
      `${f.path} on disk drifted from the generator — edit the snapshot and re-run scripts/shard.ts instead of hand-editing packs`,
    );
  }
});

test("committed packs.index.yaml matches the generator byte-for-byte", () => {
  const { indexYaml } = shard(snapshotText);
  const onDisk = readFileSync(join(RULES_DIR, "packs.index.yaml"), "utf8");
  assert.equal(indexYaml, onDisk);
});

test("shard extracts the preamble (everything before the first heading)", () => {
  const { preamble } = shard(snapshotText);
  assert.ok(preamble.startsWith("# App-Level AI Agent Rules"), "preamble should be the doc header");
  assert.ok(!preamble.includes("\n## "), "preamble must stop before the first section heading");
});

test("committed content/preamble.md matches the generator byte-for-byte", () => {
  const { preamble } = shard(snapshotText);
  const onDisk = readFileSync(join(CONTENT, "preamble.md"), "utf8");
  assert.equal(preamble, onDisk);
});

test("shard throws on an unmapped heading", () => {
  const bogus = snapshotText + "\n## Totally New Unmapped Section\n- a rule\n";
  assert.throws(() => shard(bogus), /Unmapped section heading/);
});
