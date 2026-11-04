// Grants → the OS sandbox prefix for test runs (C40, ARCH 6.9) and what's missing on a machine without one (the
// test environment, with C41's cache variables, is build/env.ts). Pure: deps/real/checks.ts only spawns the prefix.
import path from "node:path";
import { parse, stringify } from "yaml";
import type { Fs, Grants, SandboxFacts, SandboxInfo, SandboxTool } from "../deps/types.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * The sandbox-exec profile: allow by default; writes only to the worktree, the cache and /dev; network by grant.
 * Inside the worktree, git's folder and rafi's records stay read-only (threat-model 10.7, threat 9): a test that
 * wrote `.git/config` (core.fsmonitor) would run code outside the sandbox at rafi's next `git add`. The last
 * matching rule wins, so the cache under `.rafi/` is allowed again at the end.
 */
function profile(grants: Grants): string {
  const lines = [
    "(version 1)", "(allow default)", "(deny file-write*)",
    '(allow file-write* (subpath (param "WORKTREE")) (subpath (param "CACHE")) (subpath "/dev"))',
    '(deny file-write* (subpath (param "GIT")) (subpath (param "RAFI")) (subpath (param "TICKETS")))',
    '(allow file-write* (subpath (param "CACHE")))',
  ];
  if (!grants.needs.includes("internet")) {
    lines.push("(deny network*)");
    if (grants.needs.includes("local-servers")) {
      // Probed on macOS 26 (M2 plan 1.3): `network*` with a `local ip` filter also let public connects through.
      lines.push('(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))',
        '(allow network-outbound (remote ip "localhost:*"))');
    }
  }
  return lines.join("\n");
}

/** Folders inside the worktree that test runs may read but not write (threat 9). */
const READ_ONLY: readonly (readonly [string, string])[] = Object.freeze([["GIT", ".git"], ["RAFI", ".rafi"],
  ["TICKETS", ".tickets"]] as const);

export function sandboxPrefix(o: { tool: SandboxTool; worktree: string; cache: string; grants: Grants }): string[] {
  const kept = READ_ONLY.map(([name, dir]) => [name, path.join(o.worktree, dir)] as const);
  if (o.tool === "sandbox-exec") {
    return [SANDBOX_EXEC, "-D", `WORKTREE=${o.worktree}`, "-D", `CACHE=${o.cache}`,
      ...kept.flatMap(([name, dir]) => ["-D", `${name}=${dir}`]), "-p", profile(o.grants), "--"];
  }
  const prefix = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    "--bind", o.worktree, o.worktree, ...kept.flatMap(([, dir]) => ["--ro-bind-try", dir, dir]),
    "--bind", o.cache, o.cache];
  if (!o.grants.needs.includes("internet")) prefix.push("--unshare-net");
  prefix.push("--die-with-parent", "--");
  return prefix;
}

/** What's missing for a test sandbox on this machine, in words for the warning (C60); null when one works. */
export function missingReason(o: SandboxFacts): string | null {
  if (o.platform === "darwin" && "sandboxExec" in o) {
    return o.sandboxExec ? null : "sandbox-exec isn't available";
  }
  if (o.platform === "win32") return "native Windows has no sandbox rafi can use for tests";
  if (!("bwrap" in o)) return "this system has no sandbox rafi can use for tests";
  if (!o.bwrap) return "bubblewrap isn't installed";
  if (!o.bwrapWorks) return "user namespaces are blocked, so bubblewrap can't start";
  return null;
}

export function sandboxInfo(facts: SandboxFacts): SandboxInfo {
  const missing = missingReason(facts);
  if (missing) return { available: false, missing };
  return { available: true, tool: facts.platform === "darwin" ? "sandbox-exec" : "bwrap" };
}

// No sandbox on this machine (C60, ARCH 6.9 :950, NEW-SEC-4).

export type NoSandboxDecision = "saved" | "project" | "auto-approve" | "ask" | "stop";

/** In order: a saved acceptance, `checks.run_without_sandbox: true`, auto-approve, a terminal prompt, else stop. */
export function noSandboxDecision(o: { saved: boolean; setting: boolean; autoApprove: boolean; tty: boolean }):
  NoSandboxDecision {
  if (o.saved) return "saved";
  if (o.setting) return "project";
  if (o.autoApprove) return "auto-approve";
  return o.tty ? "ask" : "stop";
}

export const WARNING = (missing: string): string =>
  `This machine has no sandbox for tests (${missing}). Without one, the tests rafi runs can reach the internet ` +
  "and write outside the project. Rafi still refuses non-test commands and restores files QA's runs change.";

export const stopLine = (missing: string): string =>
  `this machine has no sandbox for tests (${missing}); set checks.run_without_sandbox: true in rafi-config.yaml ` +
  "to run them without one";

const GRANTS = "grants.yaml";
type GrantsFile = { projects?: Record<string, Record<string, unknown>> };

async function readGrants(fs: Fs, stateDir: string): Promise<GrantsFile | null> {
  const file = path.join(stateDir, GRANTS);
  if (!(await fs.stat(file))) return {};
  try {
    const value = parse(await fs.read(file)) as unknown;
    if (value === null || value === undefined) return {};
    if (typeof value !== "object" || Array.isArray(value)) return null;
    const projects = (value as GrantsFile).projects;
    if (projects !== undefined && (typeof projects !== "object" || projects === null || Array.isArray(projects))) {
      return null;
    }
    return value as GrantsFile;
  } catch {
    return null;
  }
}

/** A malformed or unreadable grants.yaml counts as "not accepted": the warning is asked, never skipped. */
export async function savedNoSandbox(fs: Fs, stateDir: string, project: string): Promise<boolean> {
  const grants = await readGrants(fs, stateDir);
  const entry = grants?.projects?.[project]?.run_without_sandbox;
  return Boolean(entry && typeof entry === "object");
}

export async function rememberNoSandbox(fs: Fs, stateDir: string, project: string, at: string): Promise<void> {
  const grants = (await readGrants(fs, stateDir)) ?? {};
  const projects = { ...(grants.projects ?? {}) };
  projects[project] = { ...(projects[project] ?? {}), run_without_sandbox: { at } };
  await fs.mkdir(stateDir);
  await fs.writeAtomic(path.join(stateDir, GRANTS), stringify({ ...grants, projects }));
}

/** Revoking is removing the entry, as for an "always" grant (decided 2026-11-02). */
export async function forgetNoSandbox(fs: Fs, stateDir: string, project: string): Promise<void> {
  const grants = await readGrants(fs, stateDir);
  if (!grants?.projects?.[project]) return;
  const { run_without_sandbox: _drop, ...rest } = grants.projects[project]!;
  const projects = { ...grants.projects, [project]: rest };
  if (!Object.keys(rest).length) delete projects[project];
  await fs.writeAtomic(path.join(stateDir, GRANTS), stringify({ ...grants, projects }));
}
