import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxProbeInventory } from "../src/linuxProbeInventory.js";

const tag = "12345678-1234-1234-1234-123456789abc";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rafi-procfs-test-"));
  const add = (pid: number, group: number, state = "S", env = "") => {
    mkdirSync(join(root, String(pid)));
    const fields = [state, "1", String(group), ...Array(16).fill("0"), "12345", "0"];
    writeFileSync(join(root, String(pid), "stat"), `${pid} (worker (with spaces)) ${fields.join(" ")}`);
    writeFileSync(join(root, String(pid), "environ"), env);
  };
  add(10, 10);
  return { root, add, scan: () => linuxProbeInventory(tag, 1000, root, statSync(root).uid, 10) };
}

test("Linux inventories exact NUL-delimited tags and detached groups without ps", () => {
  const f = fixture();
  try {
    f.add(20, 20, "S", `OTHER=RAFI_PROBE_OWNER=${tag}\0RAFI_PROBE_OWNER=${tag}-suffix\0`);
    f.add(30, 30, "S", `LONG=${"x".repeat(100000)}\0RAFI_PROBE_OWNER=${tag}\0`);
    f.add(40, 30, "Z", `RAFI_PROBE_OWNER=${tag}\0`);
    const rows = f.scan()!;
    assert.deepEqual(rows.filter(row => row.tagged).map(row => row.pid), [30]);
    assert.equal(rows.find(row => row.pid === 30)?.start, "12345");
    assert.equal(rows.find(row => row.pid === 40)?.state, "Z");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Linux inventory fails closed on malformed, missing self, or unreadable live-process environment", () => {
  const f = fixture();
  try {
    f.add(20, 20);
    rmSync(join(f.root, "20", "environ"));
    assert.equal(f.scan(), undefined);
    writeFileSync(join(f.root, "20", "environ"), "");
    writeFileSync(join(f.root, "20", "stat"), "bad stat");
    assert.equal(f.scan(), undefined);
    rmSync(join(f.root, "20"), { recursive: true });
    rmSync(join(f.root, "10"), { recursive: true });
    assert.equal(f.scan(), undefined);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
