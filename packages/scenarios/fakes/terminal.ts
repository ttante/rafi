// The fake terminal (SCN 7.6, plan choice C7): a 120×24 screen model written for rafi's own output.
// Handles CSI cursor moves and erases, the DECSTBM scroll region, OSC 0/2 titles, SGR (stripped), cursor
// show/hide and save/restore. Pipe mode keeps only the raw text.
import { PassThrough } from "node:stream";
import type { Cancel, Terminal } from "@rafi-ai/engine";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[78()][0-9A-B]?/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export class Screen {
  readonly lines: string[];
  title = "";
  row = 0;
  col = 0;
  private top = 0;
  private bottom: number;
  private saved = { row: 0, col: 0 };

  constructor(readonly columns = 120, readonly rows = 24) {
    this.lines = Array.from({ length: rows }, () => "");
    this.bottom = rows - 1;
  }

  /** Lines below the scroll region: the pinned prompts (OUT-16). */
  pinned(): string[] {
    return this.lines.slice(this.bottom + 1).map((l) => l.trimEnd()).filter(Boolean);
  }

  text(): string {
    return this.lines.map((l) => l.trimEnd()).join("\n").trimEnd();
  }

  write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === "\u001b") {
        i = this.escape(data, i);
        continue;
      }
      if (ch === "\n") this.newline();
      else if (ch === "\r") this.col = 0;
      else if (ch === "\b") this.col = Math.max(0, this.col - 1);
      else if (ch >= " ") this.put(ch);
      i += 1;
    }
  }

  private put(ch: string): void {
    if (this.col >= this.columns) { this.newline(); this.col = 0; }
    const line = this.lines[this.row]!.padEnd(this.col, " ");
    this.lines[this.row] = line.slice(0, this.col) + ch + line.slice(this.col + 1);
    this.col += 1;
  }

  private newline(): void {
    this.col = 0;
    if (this.row === this.bottom) {
      this.lines.splice(this.top, 1);
      this.lines.splice(this.bottom, 0, "");
    } else if (this.row < this.rows - 1) {
      this.row += 1;
    }
  }

  private escape(data: string, start: number): number {
    const next = data[start + 1];
    if (next === "]") {
      const end = data.slice(start).search(/\u0007|\u001b\\/);
      const stop = end < 0 ? data.length : start + end;
      const body = data.slice(start + 2, stop);
      const [kind, ...rest] = body.split(";");
      if (kind === "0" || kind === "2") this.title = rest.join(";");
      return stop + (data[stop] === "\u0007" ? 1 : 2);
    }
    if (next === "7") { this.saved = { row: this.row, col: this.col }; return start + 2; }
    if (next === "8") { ({ row: this.row, col: this.col } = this.saved); return start + 2; }
    if (next !== "[") return start + 2;
    const match = /^\u001b\[([0-?]*)([ -/]*)([@-~])/.exec(data.slice(start));
    if (!match) return start + 2;
    this.csi(match[1]!, match[3]!);
    return start + match[0].length;
  }

  private csi(params: string, final: string): void {
    const nums = params.replace(/^\?/, "").split(";").map((n) => (n === "" ? NaN : Number(n)));
    const n = (index: number, fallback = 1) => (Number.isNaN(nums[index] ?? NaN) ? fallback : nums[index]!);
    const clampRow = (r: number) => Math.min(this.rows - 1, Math.max(0, r));
    switch (final) {
      case "A": this.row = clampRow(this.row - n(0)); break;
      case "B": this.row = clampRow(this.row + n(0)); break;
      case "C": this.col = Math.min(this.columns - 1, this.col + n(0)); break;
      case "D": this.col = Math.max(0, this.col - n(0)); break;
      case "E": this.row = clampRow(this.row + n(0)); this.col = 0; break;
      case "F": this.row = clampRow(this.row - n(0)); this.col = 0; break;
      case "G": this.col = Math.max(0, n(0) - 1); break;
      case "H": case "f": this.row = clampRow(n(0) - 1); this.col = Math.max(0, n(1) - 1); break;
      case "J": this.eraseDisplay(n(0, 0)); break;
      case "K": this.eraseLine(n(0, 0)); break;
      case "r": this.top = n(0) - 1; this.bottom = Math.min(this.rows - 1, n(1, this.rows) - 1); break;
      case "s": this.saved = { row: this.row, col: this.col }; break;
      case "u": ({ row: this.row, col: this.col } = this.saved); break;
      default: break; // SGR (m), cursor show/hide (h/l) and the rest change nothing on the screen model
    }
  }

  private eraseLine(mode: number): void {
    const line = this.lines[this.row]!;
    if (mode === 0) this.lines[this.row] = line.slice(0, this.col);
    else if (mode === 1) this.lines[this.row] = " ".repeat(this.col) + line.slice(this.col);
    else this.lines[this.row] = "";
  }

  private eraseDisplay(mode: number): void {
    if (mode === 0) {
      this.eraseLine(0);
      for (let r = this.row + 1; r < this.rows; r += 1) this.lines[r] = "";
    } else if (mode === 1) {
      for (let r = 0; r < this.row; r += 1) this.lines[r] = "";
      this.eraseLine(1);
    } else {
      for (let r = 0; r < this.rows; r += 1) this.lines[r] = "";
    }
  }
}

export interface FakeTerminal extends Terminal {
  readonly screen: Screen | null;
  out(): string;
  err(): string;
  all(): string;
  send(text: string): void;
  /** No more typed input. */
  end(): void;
  interrupt(): void;
  /** A signal to rafi other than Ctrl+C's: SIGHUP (its terminal closed) or SIGTERM. */
  signal(name: "SIGHUP" | "SIGTERM"): void;
  /** A killed process prints nothing more: later writes are dropped (C156). */
  freeze(): void;
  /** Called after each write, with all the output so far. */
  onWrite(fn: () => void): Cancel;
}

/** A TTY with a screen model, or (tty: false) plain pipes. */
export function fakeTerminal(o: { tty: boolean; columns?: number; rows?: number }): FakeTerminal {
  const screen = o.tty ? new Screen(o.columns ?? 120, o.rows ?? 24) : null;
  const input = new PassThrough();
  let out = "";
  let err = "";
  let all = "";
  const interrupts = new Map<() => void, readonly string[]>();
  const writes = new Set<() => void>();
  let frozen = false;
  const wrote = () => { for (const fn of [...writes]) fn(); };
  const fire = (name: string) => { for (const [fn, on] of [...interrupts]) if (on.includes(name)) fn(); };
  return {
    screen,
    write(text) { if (frozen) return; out += text; all += text; screen?.write(text); wrote(); },
    error(text) { if (frozen) return; err += text; all += text; screen?.write(text); wrote(); },
    isTTY: o.tty,
    columns: o.columns ?? 120,
    rows: o.rows ?? 24,
    setTitle(title) { if (screen) screen.title = title; },
    onInterrupt(fn, signals = ["SIGINT"]): Cancel { interrupts.set(fn, signals); return () => interrupts.delete(fn); },
    onResize: () => () => undefined,
    input,
    out: () => out,
    err: () => err,
    all: () => all,
    send(text) { input.write(text); },
    end() { input.end(); },
    interrupt() { fire("SIGINT"); },
    signal: fire,
    freeze() { frozen = true; },
    onWrite(fn): Cancel { writes.add(fn); return () => writes.delete(fn); },
  };
}
