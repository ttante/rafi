import type { BuilderEvent } from "../adapters/types.js";

/** Print a compact live feed of builder activity. */
export async function printEvents(events: AsyncIterable<BuilderEvent>): Promise<void> {
  let atLineStart = true;
  for await (const ev of events) {
    if (ev.kind === "text") {
      if (ev.text) {
        process.stdout.write(ev.text);
        atLineStart = ev.text.endsWith("\n");
      }
    } else if (ev.kind === "tool") {
      if (!atLineStart) {
        process.stdout.write("\n");
        atLineStart = true;
      }
      console.log(`  -> ${ev.name} ${briefInput(ev.input)}`);
    } else if (ev.kind === "turn-complete") {
      if (!atLineStart) {
        process.stdout.write("\n");
        atLineStart = true;
      }
      const tag = ev.result.isError ? "turn errored" : "turn complete";
      const cost = ev.result.costUsd > 0 ? ` ($${ev.result.costUsd.toFixed(4)})` : "";
      console.log(`  - ${tag}${cost}`);
    } else if (ev.kind === "error") {
      if (!atLineStart) {
        process.stdout.write("\n");
        atLineStart = true;
      }
      console.log(`  ! error: ${ev.message}`);
    }
  }
  if (!atLineStart) process.stdout.write("\n");
}

function briefInput(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const key = o.command ?? o.file_path ?? o.path ?? o.pattern ?? "";
    return String(key).slice(0, 80);
  }
  return "";
}
