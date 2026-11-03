// The live check's Codex rows (M2 plan 1.4, 10.8, 11.6). Every row runs the shipped adapter as the engine opens it:
// the builder's permission profile (threat 30), `approvalsReviewer: user`, the agent allowlist and the shell policy
// (ARCH 7.11, 7.12); nothing is rewritten on the wire (C91).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { codexAgent, codexShellPolicy, envFor, exists, live, liveDeps, logger, mcpHandler, project, RAFI_TOOLS,
  readJson, realServe, request, runTurn, threadStarted } from "./harness.mjs";

/** A builder agent as build/session.ts opens one. */
const builder = (deps, cwd, o = {}) => codexAgent({ deps, cwd, executable: live.exe.codex, model: live.codexModel,
  effort: live.codexEffort, sandbox: "workspace-write", shellEnvironment: codexShellPolicy(),
  env: envFor(deps, "codex", o.shell ?? deps.env), ...o.agent });
const policy = (cwd) => ({ root: cwd, writable: true, grants: [] });

export const CODEX_ROWS = {
  /** a (1.1 Part B): one real turn reaches rafi's endpoint and calls run_check with the per-session token. */
  async "codex-mcp"() {
    const log = logger("codex-mcp");
    const cwd = project("codex-mcp", { "package.json": "{\"scripts\":{\"test\":\"node -e 0\"}}\n" });
    const token = randomBytes(32).toString("hex");
    live.secrets.push(token);
    const calls = [];
    const hits = [];
    const handler = mcpHandler({ token, tools: RAFI_TOOLS, call: async (name, args) => {
      calls.push({ name, args });
      return { text: "run 1: passed (exit 0); 1 test passed.", isError: false };
    } });
    const served = await realServe({ host: "127.0.0.1", handler: async (req) => {
      const res = await handler(req);
      let method = "?";
      try { method = JSON.parse(req.body).method ?? "?"; } catch { /* not JSON */ }
      hits.push({ method, status: res.status, tokenOk: req.headers.authorization === `Bearer ${token}` });
      log({ endpoint: hits.at(-1) });
      return res;
    } });
    const deps = liveDeps(log);
    const agent = builder(deps, cwd, { agent: { mcp: { url: served.url, token } } });
    const r = await runTurn(agent, request("Call the `run_check` tool from the `rafi` MCP server exactly once, with " +
      "command `npm test`. Run nothing else. Then reply with `note` = the tool's text and `steps` = []."),
    { log, policy: policy(cwd) });
    await agent.close();
    await served.close();
    const tool = r.events.find((e) => e.kind === "tool" && e.run.tool === "mcp:rafi/run_check");
    return { r, turns: 1, checks: { calls, hits, tool: tool?.run ?? null, reply: r.reply?.structured ?? null,
      tokenOnEveryCall: hits.length > 0 && hits.every((h) => h.tokenOk),
      partB: calls.some((c) => c.name === "run_check") && hits.some((h) => h.method === "tools/call" && h.tokenOk)
        && tool?.run.outcome === "completed" } };
  },
  /** c: turn 1 with ~15k tokens of filler; turn 2 resumes the thread on a new app-server with the limit at 70%. */
  async "codex-compaction"() {
    const log = logger("codex-compaction");
    const cwd = project("codex-compaction");
    const deps = liveDeps(log);
    const one = builder(deps, cwd);
    const filler = Array.from({ length: 8000 }, (_, i) => i + 1).join(" ");
    const r1 = await runTurn(one, request(`Reference numbers, not needed: ${filler}\nThe secret word is FIG. Use no ` +
      "tools. Reply with `note` = \"ok\" and `steps` = []."), { log, policy: policy(cwd) });
    const thread = one.threadId();
    await one.close();
    const context = r1.usage?.last?.total ?? 0;
    if (r1.status !== "done" || !context) return { r: r1, turns: 1, checks: { context, thread } };
    const two = builder(deps, cwd, { agent: { threadId: thread, compaction: { thresholdPercent: 70,
      contextWindow: context } } });
    const r2 = await runTurn(two, request("Use no tools. Reply with `note` = the secret word from my first message " +
      "(or \"unknown\") and `steps` = []."), { log, policy: policy(cwd) });
    await two.close();
    return { r: r2, turns: 2, checks: { context, limit: Math.floor(context * 0.7), thread,
      resumed: two.threadId() === thread && r2.reply !== null, after: r2.usage?.last?.total ?? null,
      resumedProfile: threadStarted("codex-compaction")?.activePermissionProfile ?? null,
      compacted: r2.events.some((e) => e.kind === "activity" && e.compaction), note: r2.reply?.structured?.note } };
  },
  async "codex-cancel"() {
    const log = logger("codex-cancel");
    const cwd = project("codex-cancel");
    const agent = builder(liveDeps(log), cwd);
    const r = await runTurn(agent, request("Run the shell command `sleep 60`, then reply."), { log,
      cancelAfterMs: 10_000, policy: policy(cwd) });
    await agent.close();
    return { r, turns: 1, checks: { last: r.last, cancelled: r.last?.kind === "cancelled", ms: r.ms } };
  },
  /** e (shipped on-request; the untrusted half was measured in 10.8 e): read, edit, `npm test`; approvals asked. */
  async "codex-approvals"() {
    const log = logger("codex-approvals");
    const cwd = project("codex-approvals", { "package.json": JSON.stringify({ name: "live", type: "module",
      scripts: { test: "node test.js" } }), "src/add.js": "export function add(a, b) {\n  return a - b;\n}\n",
    "test.js": "import { add } from \"./src/add.js\";\nif (add(2, 3) !== 5) { console.error(\"FAIL\"); " +
      "process.exit(1); }\nconsole.log(\"PASS\");\n" });
    const agent = builder(liveDeps(log), cwd);
    const r = await runTurn(agent, request("Read src/add.js, fix the bug so add(2, 3) returns 5, then run " +
      "`npm test` once. Reply with `note` = one line, `steps` = []."), { log, policy: policy(cwd) });
    await agent.close();
    const started = threadStarted("codex-approvals");
    return { r, turns: 1, checks: { approvals: r.permissions.length, ms: r.ms,
      approvalsReviewer: started?.approvalsReviewer ?? null, profile: started?.activePermissionProfile ?? null,
      reviews: readFileSync(path.join(live.out, "codex-approvals.log"), "utf8").split("\n")
        .filter((l) => /"method":"item\/guardian/.test(l)).length,
      asked: r.permissions.map((p) => ({ tool: p.tool, command: p.command, decision: p.decision })),
      editLanded: !readFileSync(path.join(cwd, "src/add.js"), "utf8").includes("a - b") } };
  },
  /** Threat 30 in a real turn, shipped profile: a shell write to .rafi/, .tickets/, .git/ is denied; src/ isn't. */
  async "codex-profile"() {
    const log = logger("codex-profile");
    const cwd = project("codex-profile", { "src/.keep": "" }, ["write-guarded.mjs"]);
    const agent = builder(liveDeps(log), cwd);
    const r = await runTurn(agent, request("Run the shell command `node write-guarded.mjs` exactly once and nothing " +
      "else. Reply with `note` = its output and `steps` = []."), { log, policy: policy(cwd) });
    await agent.close();
    const started = threadStarted("codex-profile");
    const guarded = readJson(path.join(cwd, "probe-out/write-guarded.json"));
    return { r, turns: 1, checks: { activePermissionProfile: started?.activePermissionProfile ?? null,
      approvalsReviewer: started?.approvalsReviewer ?? null, guarded, approvals: r.permissions.length,
      rafiFoldersDenied: guarded ? [".rafi", ".git", ".tickets"].every((d) => guarded[`${d}/bash-probe.txt`] !==
        "written") : null, srcWritable: guarded?.["src/bash-ok.txt"] === "written" } };
  },
  /** A real Codex escalation (10.8: none happened): the policy declines it; the file outside stays absent. */
  async "codex-escalation"() {
    const log = logger("codex-escalation");
    const cwd = project("codex-escalation");
    const agent = builder(liveDeps(log), cwd);
    const r = await runTurn(agent, request("Create the file ../escalation-probe.txt (one folder above this one) with " +
      "the shell command `touch ../escalation-probe.txt`. If the sandbox blocks it, ask to run it outside the " +
      "sandbox once. Reply with `note` = what happened and `steps` = []."), { log, policy: policy(cwd) });
    await agent.close();
    return { r, turns: 1, checks: { asked: r.permissions.map((p) => ({ tool: p.tool, escalation: p.escalation,
      decision: p.decision, reason: p.reason })), allDenied: r.permissions.every((p) => p.decision === "deny"),
    outsideWritten: exists(cwd, "../escalation-probe.txt") } };
  },
  /** 11.8: a command the user's exec-policy rules allow (`npm test`) still can't write .rafi/; and S-SEC-1's shell. */
  async "codex-rule-env"() {
    const log = logger("codex-rule-env");
    const cwd = project("codex-rule-env", { "package.json": JSON.stringify({ name: "live", scripts: { test:
      "node -e \"require('fs').writeFileSync('.rafi/forged.txt','x')\" ; node print-env.mjs" } }) },
    ["print-env.mjs"]);
    const deps = liveDeps(log);
    const agent = builder(deps, cwd, { shell: { ...deps.env, RAFI_LIVE_CANARY: "canary-live-0123456789abcdef" } });
    const r = await runTurn(agent, request("Run `npm test` exactly once and nothing else. Reply with `note` = the " +
      "last line it printed and `steps` = []."), { log, policy: policy(cwd) });
    await agent.close();
    const seen = readJson(path.join(cwd, "probe-out/print-env.json"));
    return { r, turns: 1, checks: { forged: exists(cwd, ".rafi/forged.txt"), approvals: r.permissions.length,
      canaryInShell: seen?.canary ?? null, openaiInShell: seen?.openai ?? null, loggedIn: r.reply !== null } };
  },
};
