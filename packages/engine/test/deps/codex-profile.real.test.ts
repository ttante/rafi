// M2 plan 11.4 A11 (S0.4, threat 30, ARCH 7.11): the permission profile the Codex adapter actually sends, fed to the
// real `codex sandbox -P` (free, no model turn): rafi's records and git's folder are denied, the worktree and the
// cache stay writable. Process set only; skipped without `codex`. The project lives outside /tmp and $TMPDIR, which
// `:workspace` can always write (.rafi-build/threat30-options.md). Linux runs it in CI (C90).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { codexAgent } from "../../src/agents/codex/adapter.js";
import type { JsonRpcStream } from "../../src/deps/types.js";

const version = spawnSync("codex", ["--version"], { encoding: "utf8" });
const skip = version.status === 0 ? false : "codex isn't installed";

/** The adapter's thread/start params, from a stub app-server that answers every request. */
async function sentThreadStart(cwd: string): Promise<Record<string, unknown>> {
  const sent: Record<string, unknown>[] = [];
  const fns = new Set<(m: unknown) => void>();
  const stream: JsonRpcStream = {
    write(message) {
      const m = message as { id?: number; method?: string; params?: Record<string, unknown> };
      sent.push(m as Record<string, unknown>);
      if (m.id === undefined) return;
      const result = m.method === "turn/start" ? { turn: { id: "turn-1" } } : { thread: { id: "thread-1" } };
      queueMicrotask(() => { for (const fn of fns) fn({ id: m.id, result }); });
      if (m.method === "turn/start") queueMicrotask(() => { for (const fn of fns) fn({ method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }); });
    },
    onMessage: (fn) => { fns.add(fn); return () => fns.delete(fn); },
    onClose: () => () => undefined,
    close: async () => undefined,
    kill: () => undefined,
  };
  const unused = (() => { throw new Error("unused"); }) as never;
  const agent = codexAgent({ deps: { agents: { codex: () => stream, claudeQuery: unused }, clock: unused }, cwd,
    executable: "codex", env: {}, sandbox: "workspace-write" });
  for await (const _ of agent.turn({ meta: { key: "k", role: "builder" }, message: "m", schema: { name: "s",
    json: {} }, grants: [], tools: [] }, new AbortController().signal)) { /* drain */ }
  return sent.find((m) => m.method === "thread/start")!.params as Record<string, unknown>;
}

/** A JSON value as a TOML inline value, for `codex sandbox -c key=value`. */
function toml(value: unknown): string {
  if (value && typeof value === "object") {
    return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// P48 (M5): rafi-config.yaml is read-only too, a single-file entry; a file beside it stays writable.
const PATHS = [".rafi/state.sqlite3", ".tickets/t.yaml", ".git/config", "rafi-config.yaml", "src/a.js", ".rafi/cache/x",
  "rafi-config.yaml.bak"];

test("A11: under the profile the adapter sends, .rafi/, .tickets/, .git/ and rafi-config.yaml are denied; src/ and " +
  "the cache aren't",
  { skip }, async () => {
    const root = realpathSync(homedir());
    const project = path.join(root, ".cache", `rafi-profile-probe-${process.pid}-${Date.now()}`);
    try {
      for (const d of [".rafi/cache", ".tickets", ".git", "src"]) mkdirSync(path.join(project, d), { recursive: true });
      for (const p of PATHS) writeFileSync(path.join(project, p), "original\n");
      const start = await sentThreadStart(project);
      const profile = String(start.permissions ?? ":workspace");
      const defined = ((start.config as Record<string, unknown> | undefined)?.permissions ?? {}) as
        Record<string, unknown>;
      const config = Object.entries(defined).flatMap(([id, body]) => ["-c", `permissions.${id}=${toml(body)}`]);
      const script = `for p in ${PATHS.join(" ")}; do if ( echo x >> "$p" ) 2>/dev/null; then echo "WRITABLE $p"; ` +
        `else echo "DENIED $p"; fi; done`;
      const r = spawnSync("codex", ["sandbox", "-P", profile, ...config, "-C", project, "sh", "-c", script],
        { encoding: "utf8", cwd: project, timeout: 30_000 });
      const seen = Object.fromEntries(r.stdout.trim().split("\n").filter(Boolean).map((l) => l.split(/\s+/).reverse()));
      assert.deepEqual(seen, { ".rafi/state.sqlite3": "DENIED", ".tickets/t.yaml": "DENIED", ".git/config": "DENIED",
        "rafi-config.yaml": "DENIED", "src/a.js": "WRITABLE", ".rafi/cache/x": "WRITABLE",
        "rafi-config.yaml.bak": "WRITABLE" }, `${profile}: ${r.stdout}${r.stderr}`);
      for (const p of PATHS.slice(0, 4)) assert.equal(readFileSync(path.join(project, p), "utf8"), "original\n", p);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
