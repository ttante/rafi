// Terminal prompts through deps.terminal (ARCH 8.4): a numbered list, one typed line. The runtime prompt (C46) and
// the no-sandbox warning (C60), and "What next?" with its note and confirmation (C102). Without input, a prompt is a
// cancel.
import type { Readable } from "node:stream";
import type { Deps } from "@rafi-ai/engine";

/** Reads exactly one line and puts back what follows it, so typed-ahead answers reach the next prompt. */
export function readLine(deps: Deps): Promise<string | null> {
  const input = deps.terminal.input as Readable | null;
  if (!input) return Promise.resolve(null);
  // An input that already ended never emits "end" again: nothing more will come (C100).
  if (input.readableEnded && input.readableLength === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buffer = "";
    const done = (value: string | null) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      const rest = buffer.slice(at + 1);
      if (rest) input.unshift(rest);
      done(buffer.slice(0, at).trim());
    };
    const onEnd = () => done(buffer ? buffer.trim() : null);
    input.on("data", onData);
    input.once("end", onEnd);
    input.resume();
  });
}

/** Asks one question with numbered choices; returns the chosen index, or null (cancelled). */
export async function choose(deps: Deps, text: string, choices: readonly string[]): Promise<number | null> {
  deps.terminal.write(`${text}\n${choices.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}\n> `);
  for (let tries = 0; tries < 3; tries += 1) {
    const line = await readLine(deps);
    if (line === null) return null;
    const n = Number(line);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n - 1;
    deps.terminal.write(`Type a number from 1 to ${choices.length}.\n> `);
  }
  return null;
}

/** One typed line. With `required`, an empty line is refused with `refusal` (one line) and asked again. */
export async function askText(deps: Deps, prompt: string, o: { required: boolean; refusal: string }):
  Promise<string | null> {
  deps.terminal.write(`${prompt}\n> `);
  for (;;) {
    const line = await readLine(deps);
    if (line === null) return null;
    if (line || !o.required) return line;
    deps.terminal.write(`${o.refusal}\n> `);
  }
}
