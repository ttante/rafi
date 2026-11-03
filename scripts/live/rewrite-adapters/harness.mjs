// The live adapter check's shared parts (M2 plan 1.4, 11.6): the built engine's adapters and policy, logged real
// deps, one turn answered by the engine's own permission policy, probe projects, and each runtime's environment as
// the engine builds it (the agent allowlist, ARCH 7.12), so a row runs what ships.
import { copyFileSync, appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ENGINE = new URL("../../../packages/engine/dist/", import.meta.url);
export const { claudeAgent, codexAgent } = await import(new URL("agents/index.js", ENGINE));
export const { realDeps, realServe } = await import(new URL("deps/real/index.js", ENGINE));
export const { mcpHandler, RAFI_TOOLS } = await import(new URL("tools/index.js", ENGINE));
export const { decidePermission } = await import(new URL("agents/permissions.js", ENGINE));
export const { agentEnv, codexShellPolicy } = await import(new URL("build/env.js", ENGINE));

const PROBES = new URL("probes/", import.meta.url);

/** The run's settings and shared state, set once by the entry script. */
export const live = { out: "", deadline: 0, secrets: [], state: {}, exe: { claude: null, codex: null },
  claudeModel: "haiku", codexModel: undefined, codexEffort: "low" };

export function logger(row) {
  const file = path.join(live.out, `${row}.log`);
  writeFileSync(file, "");
  return (entry) => {
    let line = JSON.stringify({ ms: Date.now(), ...entry });
    for (const s of live.secrets) line = line.split(s).join("<token>");
    appendFileSync(file, `${line}\n`);
  };
}

/** The real deps, with each transport logged (values of the env are never logged, only its names). */
export function liveDeps(log) {
  const real = realDeps();
  const codex = (o) => {
    log({ spawn: { args: o.args, cwd: o.cwd, envNames: Object.keys(o.env ?? {}).sort() } });
    const s = real.agents.codex(o);
    return { ...s, write: (m, meta) => { log({ send: m }); s.write(m, meta); },
      onMessage: (fn) => s.onMessage((m) => { log({ recv: m }); fn(m); }) };
  };
  const claudeQuery = (p) => {
    const { abortController: _a, canUseTool: _c, hooks, mcpServers: _m, env, ...shown } = p.options;
    log({ options: { ...shown, hooks: Object.keys(hooks ?? {}), envNames: Object.keys(env ?? {}).sort() } });
    const q = real.agents.claudeQuery(p);
    return { async *[Symbol.asyncIterator]() { for await (const m of q) { log({ sdk: m }); yield m; } },
      interrupt: () => q.interrupt() };
  };
  return { ...real, agents: { ...real.agents, codex, claudeQuery } };
}

/** The runtime's environment as the engine gives it: the allowlist plus `agentsEnv`, from `shell`. */
export function envFor(deps, runtime, shell = deps.env, agentsEnv = []) {
  return agentEnv(shell, runtime, agentsEnv, process.platform);
}

const SCHEMA = { name: "live", json: { type: "object", additionalProperties: false, required: ["note", "steps"],
  properties: { note: { type: "string" }, steps: { type: "array", items: { type: "string" } } } } };
export const request = (message, o = {}) => ({ meta: { key: `live:${o.role ?? "builder"}`, role: o.role ?? "builder" },
  message, schema: SCHEMA, grants: o.grants ?? [], tools: [], ...(o.instructions ? { instructions: o.instructions }
    : {}) });

/** One turn; permissions answered by the engine's own policy; ends on the deadline, a cancel or the turn's end. */
export async function runTurn(agent, req, { log, policy, cancelAfterMs, limitMs = 240_000 }) {
  const left = Math.min(limitMs, live.deadline - Date.now());
  const out = { status: "done", events: [], permissions: [], ms: 0 };
  if (left < 30_000) return { ...out, status: "deadline" };
  const ac = new AbortController();
  const started = Date.now();
  let timedOut = false;
  const timers = [setTimeout(() => { timedOut = true; ac.abort(); }, left),
    setTimeout(() => void agent.close(), left + 30_000)];
  if (cancelAfterMs) timers.push(setTimeout(() => { log({ cancel: true }); ac.abort(); }, cancelAfterMs));
  for await (const e of agent.turn(req, ac.signal)) {
    if (e.kind === "permission") {
      const a = decidePermission(e.request, { repair: false, ...policy });
      out.permissions.push({ ...e.request, decision: a.decision, reason: a.reason, atMs: Date.now() - started });
      log({ permission: e.request, answer: a });
      e.decide(a.decision);
    } else {
      out.events.push(e);
      log({ event: e });
    }
  }
  for (const t of timers) clearTimeout(t);
  out.ms = Date.now() - started;
  const last = out.events.at(-1);
  if (timedOut) out.status = "deadline";
  else if (last?.kind === "error" && last.code === "quota") out.status = "quota";
  out.reply = out.events.find((e) => e.kind === "reply") ?? null;
  out.usage = out.events.filter((e) => e.kind === "usage").at(-1) ?? null;
  out.last = last ?? null;
  return out;
}

/** A probe project under the output folder (outside /tmp): `files`, plus `probes` copied from probes/. */
export function project(name, files = {}, probes = []) {
  const dir = realpathSync(mkdtempSync(path.join(live.out, `p-${name}-`)));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  for (const probe of probes) copyFileSync(new URL(probe, PROBES), path.join(dir, probe));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  for (const d of [".rafi/cache", ".tickets"]) mkdirSync(path.join(dir, d), { recursive: true });
  return dir;
}

export const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

/** thread/start's (or thread/resume's) result as logged for a row: the reviewer and permission profile it got. */
export const threadStarted = (row) => readFileSync(path.join(live.out, `${row}.log`), "utf8").trim().split("\n")
  .map((l) => JSON.parse(l)).find((l) => l.recv?.result?.thread && "approvalsReviewer" in l.recv.result)
  ?.recv.result ?? null;

export const exists = (cwd, file) => existsSync(path.join(cwd, file));

export const FAKE_RAFI = "#!/bin/sh\necho ran > \"$(dirname \"$0\")/../rafi-ran.txt\"\necho \"fake rafi ran: $*\"\n";
export const STEPS = "Do each step once, in order, even if one fails, then reply with `steps`: one short line per " +
  "step saying what happened.";
