// A bounded shell grammar (slimmed from ai-foreman/src/permissions/shellForms.ts): split one command into argv the
// way a shell would for plain words and quotes, and refuse every operator, redirect and expansion. rafi spawns the
// argv without a shell, so anything that would need one is refused, never interpreted.
const OPERATORS = /[|&;<>()$`\n\r]/;

export function splitCommand(command: string): { ok: true; argv: string[] } | { ok: false; reason: string } {
  const argv: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === "$" || ch === "`")) return { ok: false, reason: "shell expansion" };
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === "\\") {
      const next = command[++i];
      if (next === undefined || next === "\n") return { ok: false, reason: "a trailing escape" };
      word += next;
      started = true;
      continue;
    }
    if (OPERATORS.test(ch)) return { ok: false, reason: `the shell operator ${JSON.stringify(ch)}` };
    if (/\s/.test(ch)) {
      if (started) argv.push(word);
      word = "";
      started = false;
      continue;
    }
    word += ch;
    started = true;
  }
  if (quote) return { ok: false, reason: "an unterminated quote" };
  if (started) argv.push(word);
  return argv.length ? { ok: true, argv } : { ok: false, reason: "an empty command" };
}
