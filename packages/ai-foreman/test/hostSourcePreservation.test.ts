import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBuildSource } from "../src/buildAssignment.js";
import { inspectFilePreservation, filePreservationSchema } from "../src/hostSourcePreservation.js";

function fixture(action: (root: string, git: (...args: string[]) => Buffer) => void) {
  const root = mkdtempSync(join(tmpdir(), "host-preservation-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  try {
    git("init", "-q");
    writeFileSync(join(root, "index.mjs"), "export const add = (a, b) => a + b;\n");
    git("add", "index.mjs");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
    action(root, git);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const state of ["clean", "staged", "unstaged", "untracked"] as const) {
  test(`host proves byte-preserving append against ${state} baseline without changing source or Git`, () => fixture((root, git) => {
    const path = state === "untracked" ? "new.mjs" : "index.mjs";
    const original = `export const add = (a, b) => a + b;\n${state === "clean" ? "" : "// λ baseline\n"}`;
    writeFileSync(join(root, path), original);
    if (state === "staged") git("add", path);
    const baseline = captureBuildSource(root);
    writeFileSync(join(root, path), `${original}export const subtract = (a, b) => a - b;\n`);
    const final = captureBuildSource(root);
    const result = inspectFilePreservation(root, baseline, [path])[0]!;
    assert.equal(filePreservationSchema.safeParse(result).success, true);
    assert.equal(result.status, "compared");
    assert.equal(result.baselineIsExactPrefix, true);
    assert.equal(result.baselineEndsWithNewline, true);
    assert.equal(result.baselineBytes, Buffer.byteLength(original));
    assert.equal(captureBuildSource(root).digest, final.digest, "Proof must not alter the source, index, refs or configuration");
    assert.equal(JSON.stringify(result).includes("export const"), false, "Private baseline content is not disclosed");
    writeFileSync(join(root, path), original.replace("a + b", "a - b") + "// appended\n");
    assert.equal(inspectFilePreservation(root, baseline, [path])[0]!.baselineIsExactPrefix, false);
  }));
}

test("missing or stale baseline lengths cannot manufacture preservation", () => fixture(root => {
  writeFileSync(join(root, "index.mjs"), "dirty baseline\n");
  const before = captureBuildSource(root);
  writeFileSync(join(root, "index.mjs"), "dirty baseline\nappend\n");
  assert.equal(inspectFilePreservation(root, { ...before, fileByteLengths: {} }, ["index.mjs"])[0]!.status, "unavailable");
  assert.equal(inspectFilePreservation(root, { ...before, fileByteLengths: { "index.mjs": 0 } }, ["index.mjs"])[0]!.baselineIsExactPrefix, false);
}));

test("bounded comparisons do not follow symlinks, invent absent baselines, or claim incomplete lines", () => fixture(root => {
  writeFileSync(join(root, "index.mjs"), "baseline");
  const before = captureBuildSource(root);
  writeFileSync(join(root, "index.mjs"), "baseline-more\n");
  const proof = inspectFilePreservation(root, before, ["index.mjs"])[0]!;
  assert.equal(proof.baselineIsExactPrefix, true);
  assert.equal(proof.baselineEndsWithNewline, false);
  writeFileSync(join(root, "new.mjs"), "new file\n");
  assert.equal(inspectFilePreservation(root, before, ["new.mjs"])[0]!.status, "unavailable");
  symlinkSync("index.mjs", join(root, "link.mjs"));
  assert.equal(inspectFilePreservation(root, before, ["link.mjs"])[0]!.status, "unavailable");
  writeFileSync(join(root, "index.mjs"), Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.equal(inspectFilePreservation(root, before, ["index.mjs"])[0]!.status, "unavailable");
  assert.equal(inspectFilePreservation(root, before, Array.from({ length: 25 }, () => "new.mjs")).length, 20);
}));
