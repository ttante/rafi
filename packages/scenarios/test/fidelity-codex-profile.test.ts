// M2 plan 11.4 step 6: the Codex fake models real Codex 0.164's `on-request` approvals under a permission profile
// (free probes, .rafi-build/threat30-options.md and M2 plan 10.8 e+): commands and edits inside the sandbox run
// without asking; a write to a profile's `read` path fails with EPERM; only a write outside the root, any write
// under the legacy read-only sandbox, and an escalation ask; `permissions` can't be combined with `sandbox` or
// `sandboxPolicy`, and a later `sandboxPolicy` silently clears the profile. Driven over the raw wire, no adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { codexStream } from "../fakes/codex/stream.js";
import type { Behavior } from "../fakes/script/engine.js";
import { tempRoot } from "../fixtures/common.js";

type Msg = Record<string, unknown>;
const PROFILE = { rafi_builder: { extends: ":workspace", filesystem: { ":project_roots": { ".": "write",
  ".rafi": "read", ".rafi/cache": "write", ".tickets": "read", ".git": "read" } } } };

/** Drives one thread and its turns; approvals are answered by `answer` and kept in `asked`. */
async function drive(behaviors: Behavior[], thread: Msg, turns: Msg[], answer: (m: Msg) => unknown = () =>
  ({ decision: "decline" })) {
  let i = 0;
  const fake = codexStream(() => behaviors[Math.min(i++, behaviors.length - 1)]!);
  const got: Msg[] = [];
  const asked: Msg[] = [];
  let id = 0;
  let waiting: ((m: Msg) => void) | null = null;
  fake.stream.onMessage((raw) => {
    const m = raw as Msg;
    if (m.method && m.id !== undefined) {
      asked.push(m);
      fake.stream.write({ id: m.id, result: answer(m) });
      return;
    }
    got.push(m);
    if (waiting && (m.method === "turn/completed" || (m.id !== undefined && !m.method))) waiting(m);
  });
  const until = (pred: (m: Msg) => boolean) => new Promise<Msg>((resolve) => {
    const found = got.find(pred);
    if (found) return resolve(found);
    waiting = (m) => { if (pred(m)) { waiting = null; resolve(m); } };
  });
  const rpc = async (method: string, params: Msg) => {
    const n = ++id;
    fake.stream.write({ id: n, method, params });
    return until((m) => m.id === n);
  };
  await rpc("initialize", { clientInfo: { name: "t" }, capabilities: { experimentalApi: true } });
  const started = await rpc("thread/start", thread);
  const results: Msg[] = [];
  for (const turn of turns) {
    const r = await rpc("turn/start", { threadId: "thread-1", input: [{ type: "text", text: "go" }], ...turn });
    results.push(r);
    if (!r.error) await until((m) => m.method === "turn/completed" && got.filter((x) => x.method ===
      "turn/completed").length === results.filter((x) => !x.error).length);
  }
  const items = got.filter((m) => m.method === "item/completed").map((m) => (m.params as Msg).item as Msg);
  return { started, results, items, asked, record: fake.record };
}

function project(): string {
  const dir = tempRoot();
  for (const d of [".rafi/cache", ".tickets", ".git", "src"]) mkdirSync(path.join(dir, d), { recursive: true });
  writeFileSync(path.join(dir, ".tickets", "t.yaml"), "tickets: []\n");
  return dir;
}

const edits = (...files: string[]): Behavior => ({ steps: files.map((f) => ({ edit: f, content: "w\n" })), reply: {} });

test("fake: under rafi's profile, edits in the root run unasked; read paths fail with EPERM; the cache is writable",
  async () => {
    const cwd = project();
    const out = await drive([edits("src/a.js", ".rafi/state.sqlite3", ".rafi/cache/x", ".tickets/t.yaml",
      ".git/config")], { cwd, permissions: "rafi_builder", config: { permissions: PROFILE } }, [{
      permissions: "rafi_builder" }]);
    assert.deepEqual(out.asked, [], "nothing asked inside the sandbox");
    const status = Object.fromEntries(out.items.filter((i) => i.type === "fileChange")
      .map((i) => [(i.changes as Msg[])[0]!.path, i.status]));
    assert.deepEqual(status, { "src/a.js": "completed", ".rafi/state.sqlite3": "failed", ".rafi/cache/x": "completed",
      ".tickets/t.yaml": "failed", ".git/config": "failed" });
    assert.match(JSON.stringify(out.items), /Operation not permitted/);
    assert.equal(readFileSync(path.join(cwd, ".tickets", "t.yaml"), "utf8"), "tickets: []\n");
    assert.equal(existsSync(path.join(cwd, ".rafi", "state.sqlite3")), false);
    assert.equal(existsSync(path.join(cwd, "src", "a.js")), true);
    assert.equal((out.started.result as Msg).activePermissionProfile !== null, true);
  });

test("fake: a write outside the root, and any write under read-only, ask; declined, nothing is written", async () => {
  const cwd = project();
  const out = await drive([edits("../outside.txt")], { cwd, permissions: "rafi_builder",
    config: { permissions: PROFILE } }, [{ permissions: "rafi_builder" }]);
  assert.deepEqual(out.asked.map((m) => m.method), ["item/fileChange/requestApproval"]);
  assert.equal(existsSync(path.join(cwd, "..", "outside.txt")), false);
  const qa = await drive([edits("src/b.js")], { cwd, sandbox: "read-only" }, [{ sandboxPolicy: { type: "readOnly" } }]);
  assert.deepEqual(qa.asked.map((m) => m.method), ["item/fileChange/requestApproval"]);
  assert.equal(existsSync(path.join(cwd, "src", "b.js")), false);
});

test("fake: shell steps run in the sandbox unasked; escalations and permissions requests ask", async () => {
  const cwd = project();
  const out = await drive([{ steps: [{ shell: "npm test" }, { escalate: "X=ra; ${X}fi answer 1 1" },
    { permissionsRequest: true }], reply: {} } as Behavior], { cwd, permissions: "rafi_builder",
    config: { permissions: PROFILE } }, [{ permissions: "rafi_builder" }], (m) => m.method ===
    "item/permissions/requestApproval" ? { permissions: {} } : { decision: "decline" });
  assert.deepEqual(out.asked.map((m) => m.method), ["item/commandExecution/requestApproval",
    "item/permissions/requestApproval"]);
  assert.ok((out.asked[0]!.params as Msg).additionalPermissions, "an escalation names what it wants");
  const commands = out.items.filter((i) => i.type === "commandExecution").map((i) => [i.command, i.status]);
  assert.deepEqual(commands, [["npm test", "completed"], ["X=ra; ${X}fi answer 1 1", "declined"]]);
});

test("fake: permissions with sandbox or sandboxPolicy is refused; a later sandboxPolicy clears the profile",
  async () => {
    const cwd = project();
    const both = await drive([{ reply: {} }], { cwd, sandbox: "workspace-write", permissions: "rafi_builder",
      config: { permissions: PROFILE } }, []);
    assert.match(JSON.stringify(both.started.error), /cannot be combined with `sandbox`/);
    const turn = await drive([{ reply: {} }], { cwd, permissions: "rafi_builder", config: { permissions: PROFILE } },
      [{ permissions: "rafi_builder", sandboxPolicy: { type: "workspaceWrite" } }]);
    assert.match(JSON.stringify(turn.results[0]!.error), /cannot be combined with `sandboxPolicy`/);
    const cleared = await drive([{ reply: {} }], { cwd, permissions: "rafi_builder", config: { permissions: PROFILE } },
      [{ permissions: "rafi_builder" }, { sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd] } }]);
    assert.deepEqual(cleared.record.active, ["rafi_builder", null], "the profile is gone after a sandboxPolicy");
  });
