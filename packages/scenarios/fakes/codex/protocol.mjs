// The fake Codex app-server protocol, shared by the in-memory stream (in-process) and codex-cli.mjs (process
// set), so both speak the same wire. Modeled on rafi/test/fixtures/e2e-codex-faults.cjs: thread/start,
// thread/resume, turn/start, token usage, the final message and turn/completed, turn/interrupt. A behavior's
// `steps` run in order: activity, an edit (a fileChange item), a shell command, an escalation, a permissions
// request, run_check through rafi's MCP endpoint from the thread config (`callMcp`), then the reply (or raw text, an
// error with its codexErrorInfo and reset time, a hang, a crash, slow work, two final messages). Approvals follow
// real 0.164's `on-request` (sandbox.mjs): only what leaves the sandbox asks; the top-level `bash` is an escalation.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createSandbox } from "./sandbox.mjs";

const RUNS = "$runs";
const ERROR_INFO = { quota: "usageLimitExceeded", auth: "unauthorized", transient: "httpConnectionFailed" };

/** callMcp(url, headers, body) → { status, body } posts one JSON-RPC request to rafi's endpoint. */
export function createCodexFake({ send, nextBehavior, log = () => {}, exit = () => {}, callMcp, record = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let thread = null;
  let threadParams = {};
  let turnSeq = 0;
  let hanging = null;
  let serverId = 1000;
  let rpc = 0;
  const approvals = new Map();
  let turns = 0;
  let initialized = false;
  const sandbox = createSandbox();

  const notify = (method, params) => send({ method, params: { threadId: thread, ...params } });
  const ask = (method, params) => new Promise((resolve) => {
    const id = ++serverId;
    approvals.set(id, resolve);
    send({ id, method, params: { threadId: thread, ...params } });
  });

  const finalMessage = (turnId, text) => notify("item/completed", { turnId, item: { type: "agentMessage",
    id: `msg-${turnId}-${Math.random().toString(36).slice(2, 6)}`, phase: "final_answer", text } });

  const finish = (turnId, behavior, runs) => {
    const usage = behavior.usage ?? { inputTokens: 120, outputTokens: 30 };
    notify("thread/tokenUsage/updated", { tokenUsage: { total: { ...usage,
      totalTokens: usage.inputTokens + usage.outputTokens }, last: { totalTokens: 20 },
    modelContextWindow: behavior.contextWindow ?? null } });
    if (behavior.error) {
      const code = behavior.errorCode ?? "transient";
      notify("turn/completed", { turn: { id: turnId, status: "failed", error: { message: behavior.error,
        codexErrorInfo: ERROR_INFO[code] ?? null, ...(behavior.resetAt ? { resetsAt: behavior.resetAt } : {}) } } });
      return;
    }
    const reply = behavior.reply && behavior.reply.runs === RUNS ? { ...behavior.reply, runs } : behavior.reply;
    finalMessage(turnId, behavior.raw ?? JSON.stringify(reply ?? {}));
    if (behavior.twoFinals) finalMessage(turnId, JSON.stringify(behavior.twoFinals));
    notify("turn/completed", { turn: { id: turnId, status: "completed" } });
  };

  const { escalated, runSteps } = stepRunner({ notify, ask, params: () => threadParams, callMcp, sleep, log,
    next: () => ++rpc, sandbox });

  const turn = async (request, meta) => {
    const behavior = nextBehavior(meta, { cwd: threadParams.cwd, message: request.params?.input?.[0]?.text ?? "" });
    const turnId = `turn-${++turnSeq}`;
    record({ turn: ++turns, meta, thread: threadParams, start: request.params, active: sandbox.profile() });
    log({ op: "turn", behavior: Object.keys(behavior), hasMeta: "meta" in request });
    send({ id: request.id, result: { turn: { id: turnId } } });
    if (behavior.activity) notify("item/completed", { turnId, item: { type: "agentMessage", id: `act-${turnId}`,
      phase: "commentary", text: behavior.activity } });
    if (behavior.bash) await escalated(turnId, behavior.bash);
    const runs = await runSteps(turnId, behavior);
    if (behavior.hang) { hanging = turnId; return; }
    if (behavior.crash) { exit(Number(behavior.crash === true ? 70 : behavior.crash)); return; }
    finish(turnId, behavior, runs);
  };

  return {
    onMessage(message, meta) {
      log({ op: "recv", method: message.method ?? "response", keys: Object.keys(message) });
      if (message.id !== undefined && !message.method && approvals.has(message.id)) {
        const resolve = approvals.get(message.id);
        approvals.delete(message.id);
        return resolve(message.result ?? {});
      }
      if (message.id === undefined) return undefined;
      // Real codex 0.164: every request before `initialize` is -32600 "Not initialized" (live check, plan 10.8).
      if (message.method === "initialize") {
        initialized = true;
        return send({ id: message.id, result: { userAgent: "fake-codex/0.164.0" } });
      }
      if (!initialized) return send({ id: message.id, error: { code: -32600, message: "Not initialized" } });
      const params = message.params ?? {};
      const starts = message.method === "thread/start" || message.method === "thread/resume";
      const refused = starts ? sandbox.thread(params) : message.method === "turn/start" ? sandbox.turn(params) : null;
      if (refused) return send({ id: message.id, error: { code: -32600, message: refused } });
      if (starts) {
        thread = params.threadId ?? thread ?? "thread-1";
        threadParams = params;
        return send({ id: message.id, result: { thread: { id: thread, cwd: params.cwd },
          activePermissionProfile: sandbox.active(), approvalsReviewer: params.approvalsReviewer ?? "auto_review" } });
      }
      if (message.method === "turn/start") return void turn(message, meta);
      if (message.method === "model/list") {
        return send({ id: message.id, result: { data: [{ id: "gpt-5.1-codex", model: "gpt-5.1-codex" },
          { id: "m-test", model: "m-test" }] } });
      }
      if (message.method === "turn/interrupt") {
        send({ id: message.id, result: {} });
        if (hanging) {
          notify("turn/completed", { turn: { id: hanging, status: "interrupted" } });
          hanging = null;
        }
        return undefined;
      }
      return send({ id: message.id, result: {} });
    },
  };
}

/** The steps a behavior runs inside a turn: edits, shell commands, rafi's MCP tools. */
function stepRunner(io) {
  /** A fileChange: in the sandbox's writable paths it runs unasked; a `read` path fails; outside, it asks. */
  const edit = async (turnId, step) => {
    const id = `fc-${turnId}-${io.next()}`;
    const changes = [{ path: step.edit, kind: "add" }];
    const root = io.params().cwd ?? ".";
    const access = io.sandbox.access(root, step.edit);
    io.notify("item/started", { turnId, item: { type: "fileChange", id, changes, status: "inProgress" } });
    let status = access === "write" ? "completed" : "failed";
    if (access === "ask") {
      const answer = await io.ask("item/fileChange/requestApproval", { turnId, itemId: id, reason: "write a file" });
      status = answer.decision === "accept" ? "completed" : "declined";
    }
    if (status === "completed") {
      const file = path.resolve(root, step.edit);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, step.content ?? "x\n");
    }
    io.notify("item/completed", { turnId, item: { type: "fileChange", id, changes, status,
      ...(status === "failed" ? { error: { message: `${step.edit}: Operation not permitted (os error 1)` } } : {}) } });
  };

  const command = (turnId, id, cmd, status) => io.notify("item/completed", { turnId, item: { type: "commandExecution",
    id, command: cmd, status, exitCode: status === "completed" ? 0 : null, durationMs: status === "completed" ? 5
      : null } });

  /** A command inside the sandbox: `on-request` runs it without asking. */
  const shell = async (turnId, cmd) => command(turnId, `cmd-${turnId}-${io.next()}`, cmd, "completed");

  /** The model asks to run a command outside the sandbox (with additional permissions). */
  const escalated = async (turnId, cmd) => {
    const id = `cmd-${turnId}-${io.next()}`;
    const answer = await io.ask("item/commandExecution/requestApproval", { turnId, itemId: id, command: cmd,
      reason: "needs to run outside the sandbox", additionalPermissions: { fileSystem: { write: [io.params().cwd] },
        network: { enabled: true } } });
    command(turnId, id, cmd, answer.decision === "accept" ? "completed" : "declined");
  };

  /** item/permissions/requestApproval: the model asks for more permissions for the rest of the turn. */
  const permissions = async (turnId) => {
    const answer = await io.ask("item/permissions/requestApproval", { turnId, itemId: `perm-${turnId}-${io.next()}`,
      cwd: io.params().cwd, reason: "wants more access", permissions: { fileSystem: { write: ["/"] },
        network: { enabled: true } } });
    io.log({ op: "permissions", answer });
  };

  const mcpTool = async (turnId, tool, args) => {
    const server = io.params().config?.mcp_servers?.rafi;
    const id = `mcp-${turnId}-${io.next()}`;
    io.notify("item/started", { turnId, item: { type: "mcpToolCall", id, server: "rafi", tool, arguments: args,
      status: "inProgress" } });
    let text = "";
    let status = "failed";
    if (server && io.callMcp) {
      const response = await io.callMcp(server.url, server.http_headers ?? {}, { jsonrpc: "2.0", id: io.next(),
        method: "tools/call", params: { name: tool, arguments: args } });
      io.log({ op: "mcp", tool, status: response.status });
      const body = response.status === 200 ? JSON.parse(response.body) : null;
      text = body?.result?.content?.[0]?.text ?? `HTTP ${response.status}`;
      status = body?.result && !body.result.isError ? "completed" : "failed";
    }
    io.notify("item/completed", { turnId, item: { type: "mcpToolCall", id, server: "rafi", tool, arguments: args,
      status, result: { content: [{ type: "text", text }] } } });
    return text;
  };

  const runSteps = async (turnId, behavior) => {
    const runs = [];
    for (const step of behavior.steps ?? []) {
      if (step.wait) await io.sleep(step.wait);
      if (step.echoToken) {
        const token = io.params().config?.mcp_servers?.rafi?.http_headers?.Authorization;
        io.notify("item/completed", { turnId, item: { type: "agentMessage", id: `act-${io.next()}`,
          phase: "commentary", text: `my token: ${token}` } });
      }
      if (step.activity) io.notify("item/completed", { turnId, item: { type: "agentMessage", id: `act-${io.next()}`,
        phase: "commentary", text: step.activity } });
      if (step.compact) {
        const id = `compact-${turnId}-${io.next()}`;
        io.notify("item/started", { turnId, item: { type: "contextCompaction", id } });
        io.notify("item/completed", { turnId, item: { type: "contextCompaction", id } });
      }
      if (step.edit) await edit(turnId, step);
      if (step.shell) await shell(turnId, step.shell);
      if (step.escalate) await escalated(turnId, step.escalate);
      if (step.permissionsRequest) await permissions(turnId);
      if (step.runCheck) {
        const text = await mcpTool(turnId, "run_check", { command: step.runCheck });
        const n = /\brun (\d+)/.exec(text);
        if (n) runs.push(Number(n[1]));
      }
      if (step.checkOutput) await mcpTool(turnId, "check_output", { run: step.checkOutput });
    }
    return runs;
  };

  return { escalated, runSteps };
}
