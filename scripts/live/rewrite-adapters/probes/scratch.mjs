// Live probe (10.8 f, P20): QA's temp folder (TMPDIR as the sandboxed shell sees it) and the worktree.
import { writeFileSync } from "node:fs"; import path from "node:path"; const out = { tmpdir: process.env.TMPDIR };
const dir = process.argv[2] ?? process.env.TMPDIR ?? ".";
for (const [k, f] of [["scratch", path.join(dir, "qa-scratch.txt")], ["worktree", "qa-worktree.txt"]]) {
  try { writeFileSync(f, "x"); out[k] = "written"; } catch (e) { out[k] = e.code ?? e.message; } }
console.log(JSON.stringify(out));
