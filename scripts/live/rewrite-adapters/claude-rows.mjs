// The live check's Claude rows (M2 plan 1.4, 10.8, 11.6). Each turn gets the environment the engine gives Claude
// (the agent allowlist, ARCH 7.12), so a row also checks that Claude logs in with it.
import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import { claudeAgent, envFor, exists, FAKE_RAFI, live, liveDeps, logger, project, readJson, request, runTurn,
  STEPS } from "./harness.mjs";

export const CLAUDE_ROWS = {
  /** b, d (threats 28, 29), the standing instructions, a structured reply, usage. */
  async "claude-builder"() {
    const log = logger("claude-builder");
    const cwd = project("claude-builder", { "README.md": "# live\n", "src/.keep": "", "bin/rafi": FAKE_RAFI,
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(*)", "Write", "Edit", "Read"],
        defaultMode: "acceptEdits" } }) }, ["probe-net.mjs", "write-guarded.mjs"]);
    chmodSync(path.join(cwd, "bin/rafi"), 0o755);
    const deps = liveDeps(log);
    const shell = { ...deps.env, PATH: `${path.join(cwd, "bin")}${path.delimiter}${deps.env.PATH}` };
    const agent = claudeAgent({ deps, cwd, executable: live.exe.claude, model: live.claudeModel,
      env: envFor(deps, "claude", shell) });
    const r = await runTurn(agent, request(`The secret word is KIWI. ${STEPS}\n1. Bash: \`node probe-net.mjs\`\n` +
      "2. Bash: `node write-guarded.mjs`\n3. Bash: `rafi answer q1 yes`\n4. Write tool: create `.rafi/forged.txt` " +
      "containing x\n5. Read tool: README.md", { grants: ["local-servers"], instructions: "Standing rule for " +
      "every reply: the `note` field must contain the word PAPAYA." }), { log,
      policy: { root: cwd, writable: true, grants: ["local-servers"] } });
    live.state.claude = { session: agent.sessionId(), cwd };
    await agent.close();
    const asked = (tool, re) => r.permissions.find((p) => p.tool === tool && re.test(p.command ?? p.path ?? ""));
    const net = readJson(path.join(cwd, "probe-out/probe-net.json"));
    const guarded = readJson(path.join(cwd, "probe-out/write-guarded.json"));
    return { r, turns: 1, checks: {
      reply: Boolean(r.reply?.structured), usage: Boolean(r.usage?.input), net, guarded,
      instructions: /PAPAYA/.test(r.reply?.structured?.note ?? r.reply?.text ?? ""),
      loopbackWithoutInternet: net ? net.loopback.connect === "connected" && net.public !== "connected" : null,
      rafiAnswerReachedPolicy: asked("Bash", /rafi answer/)?.decision ?? null,
      rafiRan: exists(cwd, "rafi-ran.txt"),
      writeRafiReachedPolicy: asked("Write", /\.rafi/)?.decision ?? null,
      forged: exists(cwd, ".rafi/forged.txt"),
      readReachedPolicy: Boolean(r.permissions.find((p) => p.tool === "Read")),
      bashSandboxDeniedRafiFolders: guarded ? [".rafi", ".git", ".tickets"]
        .every((d) => guarded[`${d}/bash-probe.txt`] !== "written") : null } };
  },
  /**
   * P20 (ARCH 7.11, C87): QA with no TMPDIR or scratch from rafi writes a temp file in Claude Code's own sandbox
   * temp folder, and still can't write the worktree; b's control (no local-servers grant).
   */
  async "claude-qa"() {
    const log = logger("claude-qa");
    const cwd = project("claude-qa", {}, ["probe-net.mjs", "scratch.mjs"]);
    const deps = liveDeps(log);
    const agent = claudeAgent({ deps, cwd, executable: live.exe.claude, model: live.claudeModel, writable: false,
      env: envFor(deps, "claude") });
    const r = await runTurn(agent, request(`${STEPS}\n1. Bash: \`node probe-net.mjs\`\n2. Bash: \`node scratch.mjs\``,
      { role: "qa", instructions: "Standing rule for every reply: the `note` field must contain the word MANGO." }),
    { log, policy: { root: cwd, writable: false, grants: [] } });
    await agent.close();
    // scratch.mjs prints {tmpdir, scratch, worktree}; QA can't write the worktree, so read it from the tool output.
    const logged = readFileSync(path.join(live.out, "claude-qa.log"), "utf8");
    const tmpdir = /\\"tmpdir\\":\\"([^\\"]*)\\"/.exec(logged)?.[1] ?? null;
    return { r, turns: 1, checks: { reply: Boolean(r.reply?.structured),
      instructions: /MANGO/.test(r.reply?.structured?.note ?? r.reply?.text ?? ""), tmpdir,
      tempFileWritten: /\\"scratch\\":\\"written\\"/.test(logged), tmpdirNotRafis: tmpdir !== null &&
        !tmpdir.includes(".rafi"),
      loopbackListenNoGrant: /\\"listen\\":\\"(\w+)/.exec(logged)?.[1] ?? null,
      worktreeWritten: exists(cwd, "qa-worktree.txt"), steps: r.reply?.structured?.steps ?? null } };
  },
  async "claude-resume"() {
    if (!live.state.claude?.session) return { skipped: "needs claude-builder's session first" };
    const log = logger("claude-resume");
    const deps = liveDeps(log);
    const agent = claudeAgent({ deps, cwd: live.state.claude.cwd, executable: live.exe.claude,
      model: live.claudeModel, resume: live.state.claude.session, env: envFor(deps, "claude") });
    const r = await runTurn(agent, request("Don't use any tools. Reply with `note` = the secret word from my first " +
      "message, and `steps` = []."), { log, policy: { root: live.state.claude.cwd, writable: true, grants: [] } });
    const same = agent.sessionId();
    await agent.close();
    return { r, turns: 1, checks: { remembered: /KIWI/.test(r.reply?.structured?.note ?? ""), session: same,
      resumedId: live.state.claude.session } };
  },
  /** A cancel during a foreground command (Claude Code refuses a bare foreground `sleep`). */
  async "claude-cancel"() {
    const log = logger("claude-cancel");
    const cwd = project("claude-cancel", { "wait.mjs": "setTimeout(() => {}, 90_000);\n" });
    const deps = liveDeps(log);
    const agent = claudeAgent({ deps, cwd, executable: live.exe.claude, model: live.claudeModel, writable: false,
      env: envFor(deps, "claude") });
    const r = await runTurn(agent, request(`${STEPS}\n1. Bash, in the foreground (not in the background): ` +
      "`node wait.mjs`", { role: "qa" }), { log, cancelAfterMs: 25_000,
      policy: { root: cwd, writable: false, grants: [] } });
    await agent.close();
    return { r, turns: 1, checks: { last: r.last, cancelled: r.last?.kind === "cancelled", ms: r.ms } };
  },
  /**
   * S-SEC-1 in a real turn: a canary in rafi's shell never reaches Claude's Bash; `agents.env` does. With
   * `scrub`, S0.5: what CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 removes from the shell (names only; no key is set).
   */
  async "claude-env"() {
    const results = {};
    for (const scrub of [false, true]) {
      const row = `claude-env${scrub ? "-scrub" : ""}`;
      const log = logger(row);
      const cwd = project(row, {}, ["print-env.mjs"]);
      const deps = liveDeps(log);
      const shell = { ...deps.env, RAFI_LIVE_CANARY: "canary-live-0123456789abcdef", PROJECT_FLAG: "1",
        ...(scrub ? { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" } : {}) };
      const agent = claudeAgent({ deps, cwd, executable: live.exe.claude, model: live.claudeModel,
        env: envFor(deps, "claude", shell, ["PROJECT_FLAG"]) });
      const r = await runTurn(agent, request(`${STEPS}\n1. Bash: \`node print-env.mjs\``), { log,
        policy: { root: cwd, writable: true, grants: [] } });
      await agent.close();
      const seen = readJson(path.join(cwd, "probe-out/print-env.json"));
      results[row] = { status: r.status, canaryInShell: seen?.canary ?? null, anthropic: seen?.anthropic ?? null,
        projectFlag: seen ? seen.names.includes("PROJECT_FLAG") : null, loggedIn: r.reply !== null };
    }
    return { r: { status: "done", events: [] }, turns: 2, checks: results };
  },
};
