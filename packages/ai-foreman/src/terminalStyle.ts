/** Small, dependency-free terminal styling and display sanitization helpers. */

export type TerminalColorRole = "accent" | "success" | "warning" | "error" | "info";

export interface TerminalStyleStream {
  readonly isTTY?: boolean;
}

export interface TerminalStyleContext {
  readonly stream?: TerminalStyleStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Declared data output is always plain, including FORCE_COLOR sessions. */
  readonly machineReadable?: boolean;
}

const ANSI: Record<TerminalColorRole, string> = {
  accent: "\x1b[36m",
  success: "\x1b[32m",
  warning: "\x1b[33m",
  error: "\x1b[31m",
  info: "\x1b[34m",
};
const RESET = "\x1b[39m";

export function terminalColorEnabled(context: TerminalStyleContext = {}): boolean {
  if (context.machineReadable) return false;
  const env = context.env ?? process.env;
  const stream = context.stream ?? process.stdout;
  if (Object.hasOwn(env, "NO_COLOR")) return false;
  if (env.TERM?.toLowerCase() === "dumb") return false;
  if (env.FORCE_COLOR === "0") return false;
  if (["1", "2", "3"].includes(env.FORCE_COLOR ?? "")) return true;
  if (!stream.isTTY) return false;

  // Modern Windows terminals advertise ANSI support. A bare legacy console TTY
  // is not enough evidence, so leave it readable and unstyled.
  if ((context.platform ?? process.platform) === "win32") {
    return Boolean(env.WT_SESSION || env.ANSICON || env.ConEmuANSI === "ON" || env.TERM);
  }
  return true;
}

export function styleTerminalText(role: TerminalColorRole, text: string, context: TerminalStyleContext = {}): string {
  const safeText = sanitizeTerminalText(text);
  return terminalColorEnabled(context) ? `${ANSI[role]}${safeText}${RESET}` : safeText;
}

export function accent(text: string, context?: TerminalStyleContext): string { return styleTerminalText("accent", text, context); }
export function success(text: string, context?: TerminalStyleContext): string { return styleTerminalText("success", text, context); }
export function warning(text: string, context?: TerminalStyleContext): string { return styleTerminalText("warning", text, context); }
export function error(text: string, context?: TerminalStyleContext): string { return styleTerminalText("error", text, context); }
export function info(text: string, context?: TerminalStyleContext): string { return styleTerminalText("info", text, context); }

/** Remove terminal control sequences while retaining intended line breaks. */
export function sanitizeTerminalText(value: string): string {
  return value
    // CSI, OSC, DCS/SOS/PM/APC, and two-byte ESC controls.
    .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)?/gs, "")
    .replace(/\x1b(?:[PX^_](?:.|\n)*?\x1b\\|\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/\x9d[^\x07]*(?:\x07)?/g, "")
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
