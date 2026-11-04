// The attached view (ARCH 8.4, 8.5; C141): `rafi resume` on a build another process owns renders that build's
// events from the log, from the start of the run, then live through deps.logChanged, and exits when the build ends
// (0, or 1 if it failed). It writes no build event. Text from the log is redacted and escaped again on the way out.
import { escapeControl, redactor, stopBuild, type Deps, type Engine } from "@rafi-ai/engine";
import { colorOn, label } from "./colors.js";

type Data = Record<string, unknown>;
type Ev = { seq: number; type: string; ticket_id: string | null; data: unknown; at: string };

/** One line per event that shows progress, as the owner's activity rows look. */
export function eventPrinter(deps: Deps): (e: Ev) => void {
  const redact = redactor(deps.env);
  const color = colorOn(deps.env, deps.terminal.isTTY);
  const clean = (text: unknown) => escapeControl(redact.text(String(text))).replace(/\s+/g, " ").trim().slice(0, 200);
  const roles = new Map<string, { role: string; step: string }>();
  const row = (at: string, role: string, ticket: string | null, text: string) => deps.terminal.write(
    `${at.slice(11, 19)}  ${label(role.padEnd(7), role, color)} ${(ticket ?? "-").padEnd(4)} ${text}\n`);
  return (e) => {
    const d = (e.data ?? {}) as Data;
    const who = roles.get(String(d.key)) ?? { role: "rafi", step: "turn" };
    switch (e.type) {
      case "turn.intent":
        roles.set(String(d.key), { role: String(d.role), step: String(d.step ?? d.role) });
        row(e.at, String(d.role), e.ticket_id, `${String(d.step ?? d.role)} started`);
        return;
      case "turn.activity": return row(e.at, who.role, e.ticket_id, clean(d.text));
      case "turn.tool": return row(e.at, who.role, e.ticket_id, `${clean(d.tool)} ${clean(d.command ?? "")}: ` +
        `${clean(d.outcome)}`);
      case "turn.reply": return row(e.at, who.role, e.ticket_id, `${who.step} finished`);
      case "question.opened": return deps.terminal.write(`Question ${String(d.no)}: ${clean(d.text)}\n`);
      case "build.pause_requested": return deps.terminal.write("Pausing at the next safe point…\n");
      case "build.paused": return deps.terminal.write("Paused.\n");
      case "build.stop_requested": return deps.terminal.write(d.mode === "now" ? "Stopping now…\n"
        : "Stopping after the current step…\n");
      case "build.finished": return deps.terminal.write(`The build finished${d.complete ? "" : ", with work left"}.\n`);
      case "build.stopped": return deps.terminal.write("The build stopped.\n");
      case "build.failed": return deps.terminal.write(`The build failed: ${clean(d.message)}\n`);
    }
  };
}

const ENDED: ReadonlySet<string> = new Set(["finished", "stopped", "failed"]);
const POLL_MS = 5_000;
/** Q2 (C169): after one Ctrl+C, a second within this window stops the build. */
export const SECOND_PRESS_MS = 3_000;

/** Follows `run` until it ends; the exit code. */
export async function attachView(deps: Deps, engine: Engine, run: string): Promise<number> {
  const shown = eventPrinter(deps);
  let watching = true;
  let stopping = false;
  const print: typeof shown = (e) => { if (watching) shown(e); };
  let cursor = 0;
  let finish: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => { finish = resolve; });
  let busy = false;
  let again = false;
  let over = false;
  const end = (code: number) => { if (!over) { over = true; finish(code); } };
  const pump = async (): Promise<void> => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        for await (const e of engine.events({ from: cursor, run })) { cursor = e.seq; print(e); }
        const b = engine.fold().builds[run];
        if (b && (ENDED.has(b.state) || (b.state === "waiting" && b.ownerReleased))) {
          if (stopping) deps.terminal.write(`Build ${run} stopped.\n`);
          return end(stopping ? 130 : b.state === "failed" ? 1 : 0);
        }
      } while (again);
    } finally {
      busy = false;
    }
  };
  let poll: () => void = () => undefined;
  const check = () => {
    poll = deps.clock.timer(POLL_MS, () => {
      void engine.liveness(run).then((owner) => {
        if (over) return;
        if (owner === "dead") {
          deps.terminal.write(`Build ${run}'s process ended without finishing; \`rafi resume\` continues it.\n`);
          end(1);
        } else check();
      });
    }, "poll");
  };
  const stop = deps.logChanged(engine.logPath, () => void pump());
  // Q2: the first Ctrl+C stops watching (the build goes on); a second within 3 s stops the build, gracefully.
  let window: () => void = () => undefined;
  const offInterrupt = deps.terminal.onInterrupt(() => {
    if (watching) {
      watching = false;
      deps.terminal.write(`\nStopped watching build ${run}; it keeps running. Press Ctrl+C again within 3 seconds ` +
        "to stop the build.\n");
      window = deps.clock.timer(SECOND_PRESS_MS, () => {
        deps.terminal.write(`Build ${run} keeps running; \`rafi resume\` follows it again.\n`);
        end(0);
      }, "timeout");
    } else if (!stopping) {
      window();
      stopping = true;
      void stopBuild(engine, { run, ctrlC: true }).then((said) => {
        deps.terminal.write(`${said.line}\n`);
        return pump();
      });
    }
  });
  deps.terminal.write(`Following build ${run}; another process runs it. Ctrl+C stops watching.\n`);
  check();
  await pump();
  const code = await done;
  stop();
  poll();
  window();
  offInterrupt();
  return code;
}
