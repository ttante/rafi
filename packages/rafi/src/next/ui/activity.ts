// Activity rows (OUT-8, ARCH 8.4): one timestamped row per meaningful event, redacted and escaped; harmless failed
// reads folded into one quiet line per turn (SCN-14, C56); distinct labels for each tool outcome; a heartbeat row
// every 30 s of quiet while a turn runs (C58). Terminal only; nothing here writes the log.
import { escapeControl, harmless, redactor, type AgentEvent, type BuildUI, type Cancel, type Deps,
  type ToolRun } from "@rafi-ai/engine";

import { colorOn, label } from "./colors.js";

const HEARTBEAT_MS = 30_000;
const LABEL: Readonly<Record<ToolRun["outcome"], string>> = Object.freeze({ completed: "done", failed: "failed",
  "timed-out": "timed out", cancelled: "cancelled", unknown: "outcome unknown" });

function clockText(at: Date): string {
  return at.toISOString().slice(11, 19);
}

export function activityUI(deps: Deps): BuildUI {
  const redact = redactor(deps.env);
  const color = colorOn(deps.env, deps.terminal.isTTY);
  const who = (role: string) => label(role.padEnd(7), role, color);
  const clean = (text: string) => escapeControl(redact.text(text)).replace(/\s+/g, " ").trim().slice(0, 200);
  let last = deps.clock.now().getTime();
  let quiet = 0;
  let beat: Cancel = () => undefined;
  let current = { role: "", ticket: "" };
  const row = (role: string, ticket: string | null, text: string) => {
    last = deps.clock.now().getTime();
    deps.terminal.write(`${clockText(deps.clock.now())}  ${who(role)} ${(ticket ?? "-").padEnd(4)} ${text}\n`);
  };
  const arm = () => {
    beat();
    beat = deps.clock.timer(HEARTBEAT_MS, () => {
      const idle = Math.round((deps.clock.now().getTime() - last) / 1000);
      if (idle >= HEARTBEAT_MS / 1000) {
        deps.terminal.write(`${clockText(deps.clock.now())}  ${who(current.role)} ${current.ticket.padEnd(4)} ` +
          `still working; quiet for ${idle}s\n`);
      }
      arm();
    }, "heartbeat");
  };
  const tool = (role: string, ticket: string | null, run: ToolRun) => {
    if (harmless(run)) { quiet += 1; return; }
    const duration = run.durationMs === null ? "duration unknown" : `${run.durationMs} ms`;
    const what = run.command ? ` ${clean(run.command)}` : "";
    const error = run.error && run.outcome !== "completed" ? ` — ${clean(run.error)}` : "";
    row(role, ticket, `${run.tool}${what} (call ${run.callId ?? "?"}): ${LABEL[run.outcome]}, ${duration}${error}`);
  };
  return {
    activity({ role, ticket, event }: { role: string; ticket: string | null; event: AgentEvent }) {
      if (event.kind === "activity") row(role, ticket, clean(event.text));
      else if (event.kind === "tool") tool(role, ticket, event.run);
      else if (event.kind === "question") row(role, ticket, `asked: ${clean(event.text)} (told: reply needs-input)`);
    },
    turn(phase, o) {
      if (phase === "start") {
        current = { role: o.role, ticket: o.ticket ?? "-" };
        quiet = 0;
        row(o.role, o.ticket, `${o.step} started`);
        arm();
        return;
      }
      beat();
      if (quiet) row(o.role, o.ticket, `${quiet} exploratory read${quiet === 1 ? "" : "s"} didn't find a file`);
      row(o.role, o.ticket, `${o.step} finished`);
    },
    line(text) { deps.terminal.error(`rafi: ${escapeControl(redact.text(text))}\n`); },
  };
}
