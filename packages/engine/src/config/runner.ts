// The project's test runner (C42): `checks.test_runner`, else the package.json test script through the lockfile's
// package manager, recorded as a default setting.
import path from "node:path";
import type { Settings } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import { splitCommand } from "../agents/shellForms.js";

/** C42: checks.test_runner, else the package.json test script through the lockfile's package manager. */
export async function runner(engine: Engine, settings: Settings):
  Promise<{ argv: string[] | null; scripts: string[] }> {
  const fs = engine.deps.fs;
  const pkgFile = path.join(engine.projectDir, "package.json");
  let scripts: string[] = [];
  if (await fs.stat(pkgFile)) {
    try { scripts = Object.keys((JSON.parse(await fs.read(pkgFile)) as { scripts?: object }).scripts ?? {}); } catch {
      scripts = [];
    }
  }
  const tests = scripts.filter((s) => s === "test" || s.startsWith("test:"));
  const configured = settings["checks.test_runner"]?.value as string | undefined;
  if (configured) { const s = splitCommand(configured); return { argv: s.ok ? s.argv : null, scripts: tests }; }
  if (!tests.includes("test")) return { argv: null, scripts: tests };
  const manager = (await fs.stat(path.join(engine.projectDir, "pnpm-lock.yaml"))) ? "pnpm"
    : (await fs.stat(path.join(engine.projectDir, "yarn.lock"))) ? "yarn" : "npm";
  settings["checks.test_runner"] = { value: `${manager} test`, source: "default" };
  return { argv: [manager, "test"], scripts: tests };
}
