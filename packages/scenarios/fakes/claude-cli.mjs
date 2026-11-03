// Fake `claude` executable for the process set (ARCH 11.7, D9).
// Speaks the stream-json protocol the Agent SDK uses on stdio. Plain ESM: the SDK strips NODE_OPTIONS.
// The script path is baked into a per-test shim that calls main(scriptPath) (plan choice C12);
// rafi never passes it. Until P8 is decided, rules apply in order and selectors are refused.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const VERSION = "2.1.999 (Claude Code fake)";
const ENV_LOG_KEYS = ["RAFI_ENGINE"];

function readScript(scriptPath) {
  const script = JSON.parse(readFileSync(scriptPath, "utf8"));
  for (const rule of script.rules ?? []) {
    if (rule.role || rule.ticket || rule.attempt || rule.step) {
      throw new Error("fake claude: process-mode scripts can't match by role, ticket, step or attempt yet (P8)");
    }
  }
  return script;
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function makeLog(script) {
  return (entry) => {
    if (script.log) appendFileSync(script.log, `${JSON.stringify(entry)}\n`);
  };
}

function envRecord() {
  const record = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("RAFI_") || ENV_LOG_KEYS.includes(key)) record[key] = value;
  }
  return record;
}

const STDIO = Object.freeze({
  write: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  exit: (code) => process.exit(code),
});

export class FakeClaude {
  /** io.write gets each outgoing message; io.nextRule(message) picks a turn's rule (in-process matching). */
  constructor(script, argv, io = STDIO) {
    this.io = io;
    this.script = script;
    this.log = makeLog(script);
    this.ruleIndex = 0;
    this.sessionId = argValue(argv, "--resume") ?? randomUUID();
    this.resumed = argv.includes("--resume");
    this.hooks = {};
    this.pending = new Map();
    this.nextRequest = 0;
    this.interrupted = null;
    this.busy = Promise.resolve();
    this.log({ op: "start", argv, env: envRecord(), resumed: this.resumed, session: this.sessionId });
  }

  send(message) {
    this.io.write(message);
  }

  request(body) {
    const requestId = `cli-${++this.nextRequest}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.send({ type: "control_request", request_id: requestId, request: body });
    });
  }

  respond(requestId, response) {
    this.send({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  }

  onLine(line) {
    if (!line.trim()) return;
    this.onMessage(JSON.parse(line));
  }

  onMessage(message) {
    this.log({ op: "recv", type: message.type, subtype: message.request?.subtype ?? message.response?.subtype });
    if (message.type === "control_response") {
      const resolve = this.pending.get(message.response.request_id);
      this.pending.delete(message.response.request_id);
      resolve?.(message.response.response ?? message.response);
      return;
    }
    if (message.type === "control_request") return this.onControl(message);
    if (message.type === "user") {
      this.busy = this.busy.then(() => this.turn(message));
    }
  }

  onControl(message) {
    const { subtype } = message.request;
    if (subtype === "initialize") {
      this.hooks = message.request.hooks ?? {};
      this.schema = message.request.jsonSchema;
      this.log({ op: "initialize", hooks: Object.keys(this.hooks), schema: Boolean(this.schema) });
      return this.respond(message.request_id, {
        commands: [], agents: [], output_style: "default", available_output_styles: ["default"],
        models: [], account: {}, pid: process.pid,
      });
    }
    if (subtype === "interrupt") {
      this.log({ op: "interrupt" });
      this.respond(message.request_id, {});
      this.interruptRequested = true;
      this.interrupted?.();
      return undefined;
    }
    return this.respond(message.request_id, {});
  }

  base() {
    return { session_id: this.sessionId, uuid: randomUUID() };
  }

  async fireHook(event, input) {
    for (const matcher of this.hooks[event] ?? []) {
      for (const callbackId of matcher.hookCallbackIds ?? []) {
        const output = await this.request({
          subtype: "hook_callback", callback_id: callbackId, tool_use_id: null,
          input: { hook_event_name: event, session_id: this.sessionId, cwd: process.cwd(), ...input },
        });
        this.log({ op: "hook", event, output });
      }
    }
  }

  nextRule() {
    const rules = this.script.rules ?? [];
    const rule = rules[Math.min(this.ruleIndex, rules.length - 1)] ?? {};
    this.ruleIndex += 1;
    return rule;
  }

  assistant(content) {
    this.send({
      type: "assistant", parent_tool_use_id: null, ...this.base(),
      message: {
        id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "fake-model", content,
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
  }

  toolResult(toolUseId, text, isError) {
    this.send({
      type: "user", parent_tool_use_id: null, ...this.base(),
      message: { role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: text, is_error: isError }] },
    });
  }

  result(subtype, extra) {
    const usage = this.script.usage ?? { input_tokens: 120, output_tokens: 30 };
    this.send({
      type: "result", subtype, is_error: subtype !== "success", duration_ms: 5, duration_api_ms: 3, num_turns: 1,
      result: extra.result ?? "", stop_reason: null, total_cost_usd: this.script.cost ?? 0.0012,
      usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
      modelUsage: {}, permission_denials: extra.denials ?? [], ...extra.fields, ...this.base(),
    });
  }

  async bash(command) {
    const toolUseId = `toolu_${randomUUID()}`;
    this.assistant([{ type: "tool_use", id: toolUseId, name: "Bash", input: { command } }]);
    const decision = await this.request({
      subtype: "can_use_tool", tool_name: "Bash", input: { command }, permission_suggestions: [],
      tool_use_id: toolUseId,
    });
    this.log({ op: "permission", command, behavior: decision.behavior });
    const allowed = decision.behavior === "allow";
    this.toolResult(toolUseId, allowed ? "ok" : `denied: ${decision.message ?? ""}`, !allowed);
    return allowed ? [] : [{ tool_name: "Bash", tool_use_id: toolUseId, tool_input: { command } }];
  }

  async turn(message) {
    this.interruptRequested = false;
    const rule = this.io.nextRule ? this.io.nextRule(message) : this.nextRule();
    this.log({ op: "turn", rule: rule.behavior ?? "reply", content: summarize(message.message?.content),
      keys: Object.keys(message) });
    this.send({
      type: "system", subtype: "init", cwd: process.cwd(), tools: ["Bash", "Read", "StructuredOutput"],
      mcp_servers: [], model: "fake-model", permissionMode: "default", slash_commands: [], apiKeySource: "none",
      claude_code_version: VERSION, output_style: "default", agents: [], skills: [], plugins: [], ...this.base(),
    });
    if (!this.startHookFired) {
      this.startHookFired = true;
      await this.fireHook("SessionStart", { source: this.resumed ? "resume" : "startup" });
    }
    if (rule.activity) this.assistant([{ type: "text", text: rule.activity }]);
    const denials = rule.bash ? await this.bash(rule.bash) : [];
    if (rule.behavior === "hang") return this.hang();
    if (rule.behavior === "crash") return this.io.exit(Number(rule.code ?? 1));
    if (rule.behavior === "error") return this.result("error_during_execution", { fields: { errors: [rule.message] } });
    if (rule.raw !== undefined) return this.result("success", { denials, result: rule.raw });
    const reply = rule.reply ?? {};
    const toolUseId = `toolu_${randomUUID()}`;
    this.assistant([{ type: "tool_use", id: toolUseId, name: "StructuredOutput", input: reply }]);
    this.toolResult(toolUseId, "Structured output provided successfully", false);
    this.result("success", { denials, fields: { structured_output: reply } });
  }

  hang() {
    return new Promise((resolve) => {
      this.interrupted = () => {
        this.interruptRequested = false;
        this.interrupted = null;
        this.result("error_during_execution", { fields: { errors: ["interrupted"] } });
        resolve();
      };
      if (this.interruptRequested) this.interrupted();
    });
  }
}

function summarize(content) {
  if (typeof content === "string") return content.slice(0, 200);
  return Array.isArray(content) ? content.map((part) => part.text ?? part.type).join(" ").slice(0, 200) : null;
}

export function main(scriptPath, argv = process.argv.slice(2)) {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const fake = new FakeClaude(readScript(scriptPath), argv);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => fake.onLine(line));
  lines.on("close", () => {
    fake.log({ op: "stdin-closed" });
    // A hanging turn can't finish once the SDK has gone; anything else finishes writing first.
    if (fake.interrupted) process.exit(0);
    fake.busy.finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    fake.log({ op: "sigterm" });
    process.exit(143);
  });
  process.on("exit", (code) => fake.log({ op: "exit", code }));
}
