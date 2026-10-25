import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Claude's macOS sandbox creates a Unix socket below the provider cwd. Keep
// provider workspaces short even when evidence is retained under a deep path.
const DEFAULT_WORK_BASE = process.platform === "darwin" ? "/tmp" : tmpdir();
const MAX_PROVIDER_PATH_LENGTH = 64;

function assertProviderPath(path) {
  if (path.length > MAX_PROVIDER_PATH_LENGTH) {
    throw new Error(`Live provider cwd is too long (${path.length}); choose a shorter RAFI_LIVE_WORK_ROOT`);
  }
  return path;
}

export function createLiveWorkspace(prefix, options = {}) {
  const retained = options.evidenceRoot ?? process.env.RAFI_STRUCTURED_LIVE_EVIDENCE_ROOT;
  const evidenceRoot = retained ? resolve(retained) : undefined;
  const configuredBase = process.env.RAFI_LIVE_WORK_ROOT;
  const workBase = resolve(configuredBase || DEFAULT_WORK_BASE);
  mkdirSync(workBase, { recursive: true });
  const workspaceRoot = assertProviderPath(mkdtempSync(join(workBase, "rf-w-")));
  const root = evidenceRoot ?? mkdtempSync(join(workBase, "rf-e-"));
  mkdirSync(root, { recursive: true });
  return { root, evidenceRoot: root, workspaceRoot, prefix };
}

export function liveProjectPath(workspaceRoot, name) {
  return assertProviderPath(join(workspaceRoot, name));
}
