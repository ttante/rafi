// The fake-agent rule grammar of SCN 2.2: `<role> [<ticket>[#<attempt>]] [@<step>]: <behavior>(<args>)`.
export interface Selector {
  readonly role?: string;
  readonly ticket?: string;
  readonly attempt?: number;
  readonly step?: string;
}

export interface ParsedRule {
  readonly selector: Selector;
  readonly name: string;
  readonly args: string;
}

const RULE = /^\s*([a-z-]+)(?:\s+([A-Za-z][\w-]*)(?:#(\d+))?)?(?:\s+@([a-z-]+))?\s*:\s*([a-z-]+)(?:\((.*)\))?\s*$/s;

export function parseRule(line: string): ParsedRule {
  const m = RULE.exec(line);
  if (!m) throw new Error(`fake script: can't read rule "${line}"`);
  const selector: Selector = { role: m[1], ...(m[2] ? { ticket: m[2] } : {}),
    ...(m[3] ? { attempt: Number(m[3]) } : {}), ...(m[4] ? { step: m[4] } : {}) };
  return { selector, name: m[5]!, args: (m[6] ?? "").trim() };
}

/** Splits `a, "b, c", d` at top-level commas, keeping quoted strings and brackets whole. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of args) {
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) { out.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function unquote(text: string): string {
  const t = text.trim();
  return /^["'].*["']$/s.test(t) ? t.slice(1, -1) : t;
}
