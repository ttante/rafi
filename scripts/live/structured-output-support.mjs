/** Offline-testable probe controls; not a production provider adapter. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function probeConfig(env = process.env, now = Date.now()) {
  if (env.RAFI_LIVE_STRUCTURED !== "1") throw new Error("Explicit live-provider authorization required");
  const deadline = Date.parse(env.RAFI_LIVE_DEADLINE ?? "");
  if (!Number.isFinite(deadline) || deadline <= now) throw new Error("Future RAFI_LIVE_DEADLINE required");
  const providers = (env.RAFI_LIVE_PROVIDERS ?? "claude,codex").split(",");
  if (providers.some(p => !["claude", "codex"].includes(p))) throw new Error("Unknown provider");
  if (new Set(providers).size !== providers.length) throw new Error("Duplicate providers would exceed dispatch bounds");
  const profile = env.RAFI_LIVE_STRUCTURED_PROFILE ?? "interfaces";
  if (!["interfaces", "contracts"].includes(profile)) throw new Error("Unknown structured-output profile");
  const maximumHostDispatches = providers.reduce((sum, p) => sum + (profile === "contracts" ? 3 : p === "claude" ? 4 : 5), 0);
  return { deadline, providers, profile, maximumHostDispatches };
}

export function providerVersions(providers, run, claudeExecutable = "claude") {
  return Object.fromEntries(providers.map(provider => [provider,
    run(provider === "claude" ? claudeExecutable : "codex", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim()]));
}

export class CodexRpc {
  messages = []; pending = new Map(); next = 1;
  constructor({ cwd, events = [], save = () => {}, remaining, executable = "codex", args = ["app-server", "--listen", "stdio://"] }) {
    Object.assign(this, { events, save, remaining });
    this.child = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", data => this.events.push({ provider: "codex", stderr: String(data) }));
    this.closed = new Promise(resolve => this.child.once("close", resolve));
    const fail = error => {
      this.exited = true;
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
    // Failed spawn emits error/close, but need not emit exit.
    this.child.on("error", fail);
    this.child.on("exit", () => fail(new Error("Codex exited")));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      this.messages.push(message); this.events.push({ provider: "codex", message });
      if (message.method && message.id !== undefined) {
        this.write({ id: message.id, error: { code: -32601, message: "Probe denies tools and interactive requests" } }); return;
      }
      const p = this.pending.get(message.id);
      if (p) { this.pending.delete(message.id); message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result); }
    });
  }
  write(value) { this.child.stdin.write(JSON.stringify(value) + "\n"); }
  async request(method, params, end = Infinity) {
    if (this.exited) throw new Error("Codex is not running");
    const timeout = Math.min(30_000, this.remaining(), end - Date.now());
    if (timeout <= 0) throw new Error(`RPC deadline expired: ${method}`);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.write({ id, method, params });
    });
  }
  async initialize() { await this.request("initialize", { clientInfo: { name: "rafi-comms-probe", version: "1" }, capabilities: { experimentalApi: true } }); this.write({ method: "initialized", params: {} }); }
  async turn(threadId, prompt, outputSchema, interrupt = false) {
    const end = Date.now() + this.remaining();
    const offset = this.messages.length;
    const start = await this.request("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }],
      approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
      ...(outputSchema ? { outputSchema } : {}) }, end);
    const turnId = start.turn.id;
    let terminal;
    if (interrupt) {
      // The start RPC can acknowledge a queued turn before it is active.
      while (Date.now() < end && !this.exited && !this.messages.slice(offset).some(m =>
        m.method === "turn/started" && m.params.threadId === threadId && m.params.turn.id === turnId)) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(this.messages.slice(offset).some(m => m.method === "turn/started" && m.params.threadId === threadId && m.params.turn.id === turnId), "No correlated start event");
      await this.request("turn/interrupt", { threadId, turnId }, end);
    }
    while (Date.now() < end && !this.exited) {
      terminal = this.messages.slice(offset).find(m => m.method === "turn/completed" && m.params.threadId === threadId && m.params.turn.id === turnId);
      if (terminal) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(terminal, "No correlated terminal result");
    const items = this.messages.slice(offset).filter(m => m.method === "item/completed" && m.params.threadId === threadId && m.params.turnId === turnId).map(m => m.params.item);
    assert.ok(items.every(item => !["commandExecution", "fileChange", "mcpToolCall", "webSearch", "dynamicToolCall"].includes(item.type)), "Unexpected domain tool");
    if (interrupt) { assert.equal(terminal.params.turn.status, "interrupted"); return { threadId, turnId, terminalStatus: "interrupted" }; }
    assert.equal(terminal.params.turn.status, "completed", JSON.stringify(terminal));
    const finals = items.filter(item => item.type === "agentMessage" && item.phase === "final_answer");
    assert.equal(finals.length, 1, "Expected exactly one final_answer item");
    return { threadId, turnId, terminalStatus: terminal.params.turn.status, text: finals[0].text,
      phases: items.filter(item => item.type === "agentMessage").map(item => item.phase),
      value: outputSchema ? JSON.parse(finals[0].text) : undefined };
  }
  async close() {
    this.lines.close(); this.child.stdin.end(); this.child.kill("SIGTERM");
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    await this.closed;
    clearTimeout(kill); this.save();
  }
}

