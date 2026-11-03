// The process set (SCN 7.10): runs process/*.process.ts against the built launcher. `pnpm test:process`
// builds @rafi-ai/cli and its workspace dependencies first.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..", "process");
const files = readdirSync(dir).filter((f) => f.endsWith(".process.ts")).map((f) => path.join(dir, f));
const started = performance.now();
const result = spawnSync(process.execPath, ["--conditions=source", "--import", "tsx", "--test", ...files],
  { stdio: "inherit", env: { ...process.env, TZ: "UTC" } });
console.log(`process set: ${files.length} files, ${((performance.now() - started) / 1000).toFixed(1)}s`);
process.exitCode = result.status ?? 1;
