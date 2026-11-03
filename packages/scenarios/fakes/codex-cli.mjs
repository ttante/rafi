// Fake `codex app-server` executable for the process set, rewritten from rafi/test/fixtures/e2e-codex-faults.cjs:
// it reads a script file (baked into its PATH shim, plan choice C12) instead of RAFI_E2E_FAULT, keeps an
// operation log, and records its environment for the ENV-5 check. Until P8 is decided, rules apply in order
// and a rule with a role, ticket, step or attempt selector is refused.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createCodexFake } from "./codex/protocol.mjs";

function rafiEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("RAFI_")));
}

export function main(scriptPath, argv = process.argv.slice(2)) {
  if (argv.includes("--version")) {
    process.stdout.write("codex-cli 0.164.0 (fake)\n");
    return;
  }
  const script = JSON.parse(readFileSync(scriptPath, "utf8"));
  const log = (entry) => { if (script.log) appendFileSync(script.log, `${JSON.stringify(entry)}\n`); };
  for (const rule of script.rules ?? []) {
    if (rule.selector && Object.keys(rule.selector).length) {
      throw new Error("fake codex: process-mode scripts can't match by role, ticket, step or attempt yet (P8)");
    }
  }
  let index = 0;
  const nextBehavior = () => {
    const rules = script.rules ?? [];
    const behavior = rules[Math.min(index, rules.length - 1)]?.behavior ?? { reply: {} };
    index += 1;
    return behavior;
  };
  log({ op: "start", argv, env: rafiEnv() });
  const fake = createCodexFake({
    send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`), nextBehavior, log,
    exit: (code) => setTimeout(() => process.exit(code), 10),
  });
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim()) fake.onMessage(JSON.parse(line));
  }).on("close", () => process.exit(0));
}
