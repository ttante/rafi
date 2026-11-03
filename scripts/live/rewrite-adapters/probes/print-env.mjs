// Live probe (M2 plan 11, S-SEC-1 in a real turn): which variable names the agent's shell sees, never values.
import { mkdirSync, writeFileSync } from "node:fs";
const names = Object.keys(process.env).sort();
const out = { names, canary: names.includes("RAFI_LIVE_CANARY"), openai: names.filter((n) => n.startsWith("OPENAI_")),
  anthropic: names.filter((n) => n.startsWith("ANTHROPIC_") || n.startsWith("CLAUDE_CODE_")) };
try { mkdirSync("probe-out", { recursive: true }); writeFileSync("probe-out/print-env.json", JSON.stringify(out)); }
catch {}
console.log(JSON.stringify({ count: names.length, canary: out.canary, openai: out.openai, anthropic: out.anthropic }));
