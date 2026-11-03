// Live probe (10.8 d, e+): writes to rafi's folders, git's folder, src/ and the cache.
import { mkdirSync, writeFileSync } from "node:fs"; const out = {};
for (const f of [".rafi/bash-probe.txt", ".git/bash-probe.txt", ".tickets/bash-probe.txt", "src/bash-ok.txt",
  ".rafi/cache/bash-probe.txt"]) {
  try { writeFileSync(f, "x"); out[f] = "written"; } catch (e) { out[f] = e.code ?? e.message; } }
try { mkdirSync("probe-out", { recursive: true }); writeFileSync("probe-out/write-guarded.json", JSON.stringify(out)); }
catch {}
console.log(JSON.stringify(out));
