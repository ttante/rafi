// Item 31 (M5 plan 3.3; C199, C201; R14): gh and glab through deps.exec with argument arrays and the provider's
// environment; the PR looked up by its head before one is made; "already exists" → looked up again and adopted;
// failure text sorted into 5.1's categories (from git's own text, never the redacted one); readiness.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoMerge, categoryOf, createPr, findPr, providerFor, readiness, readyPr, ProviderFailed, type Provider,
} from "../../src/git/provider.js";

interface Call { cmd: string; args: string[]; env: Record<string, string | undefined> }
type Reply = { code: number; stdout?: string; stderr?: string };

function fake(reply: (cmd: string, args: string[]) => Reply, env: Record<string, string> = {}, origin = "") {
  const calls: Call[] = [];
  const ctx = {
    engine: { projectDir: "/p", redact: (t: string) => t.replace(/ghp_\w+/g, "[REDACTED:GH_TOKEN]") },
    deps: {
      env: { PATH: "/bin", HOME: "/h", CANARY: "x", ...env }, machine: { platform: "linux" },
      exec: async (cmd: string, args: string[], o: { env?: Record<string, string | undefined> }) => {
        calls.push({ cmd, args, env: { ...(o.env ?? {}) } });
        const r = reply(cmd, args);
        return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
      git: async () => ({ code: origin ? 0 : 1, stdout: origin, stderr: "" }),
    },
  };
  return { ctx: ctx as never, calls };
}

const PR = (state = "OPEN") => JSON.stringify([{ url: "https://h/pr/1", state, isDraft: true, mergeable: "MERGEABLE" }]);
const o = { branch: "feature/T1-x", base: "main", title: "T1: x", bodyFile: "/p/.foreman/pr-bodies/b.md" };

test("gh: create, ready and auto-merge arguments; draft only for `pr`; argument arrays and the allowlisted env",
  async () => {
    const { ctx, calls } = fake((_c, a) => (a[1] === "list" ? { code: 0, stdout: PR() } : { code: 0 }),
      { GH_TOKEN: "t0k3n" });
    await createPr(ctx, "github", "/p", { ...o, draft: true });
    await createPr(ctx, "github", "/p", { ...o, draft: false });
    await readyPr(ctx, "github", "/p", "https://h/pr/1");
    await autoMerge(ctx, "github", "/p", "https://h/pr/1", "squash");
    const creates = calls.filter((c) => c.args[1] === "create");
    assert.deepEqual(creates[0]!.args, ["pr", "create", "--head", o.branch, "--base", "main", "--title", o.title,
      "--body-file", o.bodyFile, "--draft"]);
    assert.ok(!creates[1]!.args.includes("--draft"));
    assert.deepEqual(calls.find((c) => c.args[1] === "ready")!.args, ["pr", "ready", "https://h/pr/1"]);
    assert.deepEqual(calls.find((c) => c.args[1] === "merge")!.args, ["pr", "merge", "https://h/pr/1", "--auto",
      "--squash"]);
    for (const c of calls) {
      assert.equal(c.cmd, "gh");
      assert.equal(c.env.GH_TOKEN, "t0k3n");
      assert.equal(c.env.CANARY, undefined);
    }
  });

test("glab: the same verbs as merge requests", async () => {
  const { ctx, calls } = fake((_c, a) => (a[1] === "list" ? { code: 0, stdout: PR() } : { code: 0 }));
  await createPr(ctx, "gitlab", "/p", { ...o, draft: true });
  await findPr(ctx, "gitlab", "/p", o.branch);
  await readyPr(ctx, "gitlab", "/p", "https://h/pr/1");
  await autoMerge(ctx, "gitlab", "/p", "https://h/pr/1", "squash");
  assert.ok(calls.every((c) => c.cmd === "glab"));
  assert.deepEqual(calls[0]!.args, ["mr", "create", "--source-branch", o.branch, "--target-branch", "main",
    "--title", o.title, "--description-file", o.bodyFile, "--yes", "--draft"]);
  assert.deepEqual(calls.find((c) => c.args[1] === "list")!.args, ["mr", "list", "--source-branch", o.branch,
    "--all", "--output", "json"]);
  assert.deepEqual(calls.find((c) => c.args[1] === "update")!.args, ["mr", "update", "https://h/pr/1", "--ready"]);
  assert.deepEqual(calls.find((c) => c.args[1] === "merge")!.args, ["mr", "merge", "https://h/pr/1",
    "--when-pipeline-succeeds", "--squash"]);
});

test("R14: after a create, the PR is looked up by its head; 'already exists' is adopted from a second lookup",
  async () => {
    const { ctx, calls } = fake((_c, a) => (a[1] === "create"
      ? { code: 1, stderr: 'a pull request for branch "feature/T1-x" into branch "main" already exists:\nhttps://h/pr/1' }
      : { code: 0, stdout: PR() }));
    const pr = await createPr(ctx, "github", "/p", { ...o, draft: true });
    assert.equal(pr.url, "https://h/pr/1");
    assert.deepEqual(calls.map((c) => c.args[1]), ["create", "list"]);
    assert.ok(calls[1]!.args.includes("--head") && calls[1]!.args.includes(o.branch));
  });

test("a failed create that isn't 'already exists' throws with its category and opens nothing", async () => {
  const { ctx, calls } = fake(() => ({ code: 1, stderr: "HTTP 502: Bad Gateway" }));
  await assert.rejects(createPr(ctx, "github", "/p", { ...o, draft: true }),
    (e: unknown) => e instanceof ProviderFailed && e.category === "transient");
  assert.deepEqual(calls.map((c) => c.args[1]), ["create"]);
});

test("C201: failure text → transient, auth, conflict, rejected; a redaction marker never makes it auth", async () => {
  const cases: [string, string][] = [["API rate limit exceeded", "transient"], ["dial tcp: connection refused",
    "transient"], ["HTTP 503", "transient"], ["could not resolve host", "transient"],
  ["HTTP 401: Bad credentials", "auth"], ["You are not logged into any GitHub hosts. Run gh auth login", "auth"],
  ["Pull request is not mergeable: the merge commit cannot be cleanly created", "conflict"],
  ["merge conflict between base and head", "conflict"], ["Protected branch update failed", "rejected"],
  ["GraphQL: something else", "rejected"]];
  for (const [text, want] of cases) assert.equal(categoryOf(text), want, text);
  const { ctx } = fake(() => ({ code: 1, stderr: "GraphQL: field error near ghp_abcdefghijklmnop" }));
  await assert.rejects(readyPr(ctx, "github", "/p", "u"),
    (e: unknown) => e instanceof ProviderFailed && e.category === "rejected" && !e.message.includes("ghp_"));
});

test("readiness: null when logged in; else a line with the fix; providerFor reads the origin's host", async () => {
  const ok = fake(() => ({ code: 0 }));
  assert.equal(await readiness(ok.ctx, "github"), null);
  assert.deepEqual(ok.calls[0]!.args, ["auth", "status"]);
  const no = fake(() => ({ code: 1, stderr: "You are not logged into any GitLab hosts." }));
  assert.equal(await readiness(no.ctx, "gitlab"), "GitLab isn't ready: You are not logged into any GitLab hosts. " +
    "Fix it with `glab auth login`, then run `rafi resume`.");
  const which = async (origin: string, chosen = "auto"): Promise<Provider | null> =>
    providerFor(fake(() => ({ code: 0 }), {}, origin).ctx, chosen);
  assert.equal(await which("git@gitlab.example:a/b.git"), "gitlab");
  assert.equal(await which("https://github.com/a/b"), "github");
  assert.equal(await which("/tmp/remote.git"), null);
  assert.equal(await which("/tmp/remote.git", "github"), "github");
  assert.equal(await which("https://github.com/a/b", "local"), null);
});

// C360: glab prints GitLab's own merge request fields (`web_url`, `state: opened|merged|closed`, `draft`,
// `has_conflicts`, `detailed_merge_status`), not gh's; rafi reads either shape.
test("glab's GitLab-shaped JSON: web_url, opened/merged/closed, draft, has_conflicts or a conflict merge status",
  async () => {
    const mr = (x: Record<string, unknown>) => JSON.stringify([{ web_url: "https://gl/mr/1", state: "opened",
      draft: true, has_conflicts: false, detailed_merge_status: "mergeable", ...x }]);
    const shapes: [Record<string, unknown>, Record<string, unknown>][] = [
      [{}, { url: "https://gl/mr/1", state: "open", draft: true, conflicting: false }],
      [{ has_conflicts: true }, { conflicting: true }],
      [{ detailed_merge_status: "conflict" }, { conflicting: true }],
      [{ merge_status: "cannot_be_merged", detailed_merge_status: undefined }, { conflicting: true }],
      [{ state: "merged", draft: false }, { state: "merged", draft: false }],
      [{ state: "closed" }, { state: "closed" }],
    ];
    for (const [x, want] of shapes) {
      const { ctx } = fake(() => ({ code: 0, stdout: mr(x) }));
      const pr = await findPr(ctx, "gitlab", "/p", "feature/T1-x");
      assert.ok(pr, JSON.stringify(x));
      for (const [k, v] of Object.entries(want)) assert.equal((pr as never)[k], v, `${JSON.stringify(x)} → ${k}`);
    }
  });
