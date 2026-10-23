import { parseHostIpc, type HostIpc } from "rafi-spec";

type ProbeTerminal = Extract<HostIpc, { kind: "rafi-probe-result" | "rafi-probe-spawn-error" }>;
/** One registered helper may publish one terminal result. Identical delivery is idempotent. */
export class ProbeIpcTracker {
  private registered = false;
  terminal?: ProbeTerminal;
  constructor(private readonly id: string, private readonly pid: number | undefined) {}
  accept(raw: unknown): HostIpc | "conflict" | undefined {
    const message = parseHostIpc(raw);
    if (!message || !("id" in message) || message.id !== this.id || message.pid !== this.pid) return;
    if (message.kind === "rafi-probe-registered") {
      if (this.registered) return;
      this.registered = true;
      return message;
    }
    if (!this.registered || (message.kind !== "rafi-probe-result" && message.kind !== "rafi-probe-spawn-error")) return;
    if (this.terminal) return JSON.stringify(this.terminal) === JSON.stringify(message) ? undefined : "conflict";
    this.terminal = message;
    return message;
  }
}
