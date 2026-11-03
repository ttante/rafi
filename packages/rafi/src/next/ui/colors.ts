// Colors (OUT-9), ported from ai-foreman/src/terminalStyle.ts: NO_COLOR (any value) and TERM=dumb win;
// FORCE_COLOR=0 turns color off, 1–3 on; otherwise only on a terminal. Labels only; data output is always plain.
import type { Env } from "@rafi-ai/engine";

export function colorOn(env: Env, isTTY: boolean): boolean {
  if (Object.hasOwn(env, "NO_COLOR")) return false;
  if (env.TERM?.toLowerCase() === "dumb") return false;
  if (env.FORCE_COLOR === "0") return false;
  if (["1", "2", "3"].includes(env.FORCE_COLOR ?? "")) return true;
  return isTTY;
}

const ROLE: Readonly<Record<string, number>> = Object.freeze({ builder: 36, qa: 35 });

export function label(text: string, role: string, on: boolean): string {
  return on ? `\u001b[${ROLE[role] ?? 33}m${text}\u001b[0m` : text;
}
