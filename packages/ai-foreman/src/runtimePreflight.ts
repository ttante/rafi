/**
 * Runtime environment checks that must run before Rafi's main modules load.
 * Uses only Node built-ins so it still reports clearly on an unsupported
 * Node, where importing the CLI itself fails with an opaque SyntaxError.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export interface RuntimeCheck { ok: boolean; label: string; detail: string; fix?: string }

const REINSTALL_FIX = "reinstall Rafi under the active Node (npm install -g @rafi-ai/cli); in a Rafi workspace run `corepack pnpm install --frozen-lockfile`";

function packageJson(): { engines?: { node?: string }; dependencies?: Record<string, string> } {
  try { return JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")); }
  catch { return {}; }
}

/** Minimal semver check for the range forms Rafi declares: "24.x", "^13.0.3", "13.0.3". */
export function satisfiesRange(version: string, range: string): boolean {
  const parse = (value: string) => value.replace(/^[v^~=]/, "").split(".").map(part => Number.parseInt(part, 10));
  const [major, minor = 0, patch = 0] = parse(version);
  const spec = range.trim();
  if (/^\d+\.x(\.x)?$/.test(spec)) return major === Number.parseInt(spec, 10);
  const [wantMajor, wantMinor = 0, wantPatch = 0] = parse(spec);
  if (spec.startsWith("^")) return major === wantMajor && (minor > wantMinor || minor === wantMinor && patch >= wantPatch);
  return major === wantMajor && minor === wantMinor && patch === wantPatch;
}

export function checkRuntimeEnvironment(): RuntimeCheck[] {
  const pkg = packageJson();
  const checks: RuntimeCheck[] = [];
  const nodeRange = pkg.engines?.node;
  const nodeSupported = !nodeRange || satisfiesRange(process.versions.node, nodeRange);
  if (nodeRange) {
    const ok = nodeSupported;
    checks.push({ ok, label: `node ${nodeRange}`, detail: `${process.version} (${process.execPath})`,
      ...(ok ? {} : { fix: `run Rafi with Node ${nodeRange}, e.g. \`nvm use 24\`, and reinstall it there` }) });
  }
  const sqliteRange = pkg.dependencies?.["better-sqlite3"];
  const require = createRequire(import.meta.url);
  let installed: string | undefined;
  try { installed = (require("better-sqlite3/package.json") as { version: string }).version; } catch { /* reported below */ }
  if (sqliteRange) {
    const ok = Boolean(installed && satisfiesRange(installed, sqliteRange));
    checks.push({ ok, label: `better-sqlite3 ${sqliteRange}`, detail: installed ? `installed ${installed}` : "not installed",
      ...(ok ? {} : { fix: `the installed native SQLite module does not match the declared version; ${REINSTALL_FIX}` }) });
  }
  // Only probe the native binding on a supported Node with the declared
  // version: under an unsupported Node the probe can abort the process
  // (uncatchable N-API fatal error, seen on Node 18), and a mismatched module
  // may load and then crash later (seen with 12.10 under Node 24).
  if (nodeSupported && installed && (!sqliteRange || satisfiesRange(installed, sqliteRange))) {
    try {
      const Database = require("better-sqlite3") as new (path: string) => { close(): void };
      new Database(":memory:").close();
      checks.push({ ok: true, label: "native SQLite loads", detail: `Node ABI ${process.versions.modules}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const abi = /NODE_MODULE_VERSION (\d+)/.exec(message)?.[1];
      checks.push({ ok: false, label: "native SQLite loads", detail: abi ? `built for Node ABI ${abi}, active Node ABI ${process.versions.modules}` : message.split("\n")[0]!,
        fix: `rebuild the native module for this Node: ${REINSTALL_FIX}` });
    }
  }
  return checks;
}

/** Text for a failed preflight, or undefined when every check passed. */
export function runtimePreflightFailure(checks = checkRuntimeEnvironment()): string | undefined {
  const failed = checks.filter(check => !check.ok);
  if (!failed.length) return undefined;
  return ["rafi: this runtime environment cannot run Rafi:", ...failed.map(check => `  - ${check.label}: ${check.detail}${check.fix ? `\n    fix: ${check.fix}` : ""}`)].join("\n");
}
