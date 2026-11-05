// Fake `codex app-server` executable for the process set, rewritten from rafi/test/fixtures/e2e-codex-faults.cjs:
// it reads a script file (baked into its PATH shim, plan choice C12) instead of RAFI_E2E_FAULT, keeps an
// operation log, and records its environment for the ENV-5 check. A script with `match: "identity"` matches rules by
// the turn's identity from rafi's log (P8 option C, script/match.mjs); an order-only script refuses selectors.
// `kill` behaviors SIGKILL rafi (C162), and a SIGINT is logged and ignored: the fake takes rafi's cancel instead, as
// plan 9 item 2 scripts it (since M4 follow-up 2 a provider leads its own group, so the terminal's Ctrl+C skips it).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createCodexFake } from "./codex/protocol.mjs";
import { deafness } from "./script/deaf.mjs";
import { pickBehavior } from "./script/match.mjs";

function rafiEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("RAFI_")));
}

/** The rule cursor, shared by every process of one script (each agent session is its own app-server; C50). */
export function nextIndex(scriptPath) {
  const file = `${scriptPath}.cursor`;
  const index = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  writeFileSync(file, String(index + 1));
  return index;
}

/** C51: this process's ancestry, from a `ps` snapshot taken while its turn runs. */
function ancestry() {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: m[1], ppid: m[2], cmd: m[3] }));
  const chain = [];
  let pid = String(process.pid);
  for (let i = 0; i < 20 && pid !== "0" && pid !== "1"; i += 1) {
    const row = rows.find((r) => r.pid === pid);
    if (!row) break;
    chain.push(row.cmd);
    pid = row.ppid;
  }
  return chain;
}

export function main(scriptPath, argv = process.argv.slice(2)) {
  if (argv.includes("--version")) {
    process.stdout.write("codex-cli 0.164.0 (fake)\n");
    return;
  }
  const script = JSON.parse(readFileSync(scriptPath, "utf8"));
  const log = (entry) => { if (script.log) appendFileSync(script.log, `${JSON.stringify(entry)}\n`); };
  for (const rule of script.match === "identity" ? [] : script.rules ?? []) {
    if (rule.selector && Object.keys(rule.selector).length) {
      throw new Error("fake codex: process-mode scripts can't match by role, ticket, step or attempt yet (P8)");
    }
  }
  const nextBehavior = (meta, ctx) => {
    const picked = pickBehavior(script, scriptPath, ctx, () => nextIndex(scriptPath));
    if (script.ps) log({ op: "ps", ancestry: ancestry() });
    log({ op: "pick", identity: picked.identity, rule: picked.rule ?? null, kill: picked.behavior.kill ?? null });
    // Until then SIGTERM keeps its default action; from then it's only logged.
    if (picked.behavior.ignoreTerm && !deaf.on) { deaf.start(); process.on("SIGTERM", () => deaf.term()); }
    return picked.behavior;
  };
  const killHost = () => {
    log({ op: "killhost", ppid: process.ppid });
    process.kill(process.ppid, "SIGKILL");
  };
  process.on("SIGINT", () => log({ op: "sigint" }));
  const deaf = deafness(log);
  log({ op: "start", argv, env: rafiEnv(), pid: process.pid, ppid: process.ppid });
  const callMcp = async (url, headers, body) => {
    const response = await fetch(url, { method: "POST", body: JSON.stringify(body), headers: { ...headers,
      "content-type": "application/json", accept: "application/json, text/event-stream" } });
    return { status: response.status, body: await response.text() };
  };
  const fake = createCodexFake({
    send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`), nextBehavior, log, callMcp,
    exit: (code) => setTimeout(() => process.exit(code), 10), killHost,
  });
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim()) fake.onMessage(JSON.parse(line));
  }).on("close", () => { if (!deaf.on) process.exit(0); });
}
