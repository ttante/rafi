import type { BuilderEvent } from "../adapters/types.js";
import { currentActivity } from "../activity.js";

/** Print a compact live feed of builder activity. */
export async function printEvents(events: AsyncIterable<BuilderEvent>): Promise<void> {
  let atLineStart = true;
  const startedTools = new Set<string>();
  for await (const ev of events) {
    if (ev.kind === "text") {
      if (ev.text) {
        const reporter = currentActivity();
        if (reporter) { reporter.writePersistent(ev.text); atLineStart = true; }
        else { process.stdout.write(ev.text); atLineStart = ev.text.endsWith("\n"); }
      }
    } else if (ev.kind === "tool") {
      const key = ev.callId ?? `${ev.name}\u0000${briefInput(ev.input)}`;
      // A tool normally arrives as started, progress, then completed.  The
      // activity reporter owns that mutable live state; keeping only its
      // initial permanent line avoids printing the same operation three times.
      if (ev.lifecycle === "progress") continue;
      if (ev.lifecycle === "completed" && startedTools.delete(key) && ev.status !== "failed" && (ev.exitCode === undefined || ev.exitCode === 0)) continue;
      if (ev.lifecycle === "started") {
        startedTools.add(key);
        // The activity display is mutable, so a started tool is shown there
        // and then replaced by its next state instead of becoming a durable
        // line in the feed.
        if (currentActivity()) continue;
      }
      if (!atLineStart) {
        process.stdout.write("\n");
        atLineStart = true;
      }
      const outcome = ev.lifecycle === "completed"
        ? ev.status === "failed" || (ev.exitCode !== undefined && ev.exitCode !== 0) ? " failed" : " completed"
        : "";
      writeLine(`  -> ${ev.name} ${briefInput(ev.input)}${outcome}`.trimEnd());
    } else if (ev.kind === "turn-complete") {
      if (!atLineStart) {
        process.stdout.write("\n");
        atLineStart = true;
      }
      const tag = ev.result.isError ? "turn errored" : "turn complete";
      const cost = ev.result.costUsd > 0 ? ` ($${ev.result.costUsd.toFixed(4)})` : "";
      writeLine(`  - ${tag}${cost}`);
    } else if (ev.kind === "error") {
      if (!atLineStart) {
        process.stdout.write("\n");
        atLineStart = true;
      }
      writeLine(`  ! error: ${ev.message}`);
    } else if (ev.kind === "retry" && !currentActivity()) {
      const attempt = ev.attempt ? ` (${ev.attempt}${ev.maximum ? `/${ev.maximum}` : ""})` : "";
      writeLine(`  ! ${ev.provider}: ${ev.reason}; retrying${attempt}`);
    }
  }
  if (!atLineStart) process.stdout.write("\n");
}

function writeLine(line: string): void {
  const reporter = currentActivity();
  if (reporter) reporter.writePersistent(line);
  else console.log(line);
}

function briefInput(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const key = o.command ?? o.file_path ?? o.path ?? o.pattern ?? "";
    return String(key).slice(0, 80);
  }
  return "";
}
