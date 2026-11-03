// The fake Codex app-server protocol, shared by the in-memory stream (in-process) and codex-cli.mjs (process
// set), so both speak the same wire. Modeled on rafi/test/fixtures/e2e-codex-faults.cjs: thread/start,
// thread/resume, turn/start, token usage, the final message and turn/completed, plus the M1 behaviors
// (activity, a shell call with an approval request, hang, error, crash) and turn/interrupt.

/** A behavior: { reply, activity, bash, hang, error, crash, usage }; see fakes/script/engine.ts. */
export function createCodexFake({ send, nextBehavior, log = () => {}, exit = () => {} }) {
  let thread = null;
  let turnSeq = 0;
  let pendingApproval = null;
  let hanging = null;
  let serverId = 1000;

  const finish = (turnId, behavior) => {
    const usage = behavior.usage ?? { inputTokens: 120, outputTokens: 30 };
    send({ method: "thread/tokenUsage/updated", params: { threadId: thread, tokenUsage: {
      total: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens }, last: { totalTokens: 20 } } } });
    if (behavior.error) {
      send({ method: "turn/completed", params: { threadId: thread, turn: { id: turnId, status: "failed",
        error: { message: behavior.error } } } });
      return;
    }
    send({ method: "item/completed", params: { threadId: thread, turnId, item: { type: "agentMessage",
      id: `msg-${turnId}`, phase: "final_answer", text: JSON.stringify(behavior.reply ?? {}) } } });
    send({ method: "turn/completed", params: { threadId: thread, turn: { id: turnId, status: "completed" } } });
  };

  const afterTool = (turnId, behavior) => {
    if (behavior.hang) {
      hanging = turnId;
      return;
    }
    if (behavior.crash) {
      exit(Number(behavior.crash === true ? 70 : behavior.crash));
      return;
    }
    finish(turnId, behavior);
  };

  const shell = (turnId, behavior, decision) => {
    const accepted = decision === "accept";
    send({ method: "item/completed", params: { threadId: thread, turnId, item: { type: "commandExecution",
      id: `cmd-${turnId}`, command: behavior.bash, status: accepted ? "completed" : "declined",
      exitCode: accepted ? 0 : null, durationMs: accepted ? 5 : null } } });
    afterTool(turnId, behavior);
  };

  const turn = (request, meta) => {
    const behavior = nextBehavior(meta);
    const turnId = `turn-${++turnSeq}`;
    log({ op: "turn", behavior: Object.keys(behavior), hasMeta: "meta" in request });
    send({ id: request.id, result: { turn: { id: turnId } } });
    if (behavior.activity) {
      send({ method: "item/completed", params: { threadId: thread, turnId, item: { type: "agentMessage",
        id: `act-${turnId}`, phase: "commentary", text: behavior.activity } } });
    }
    if (behavior.bash) {
      const id = ++serverId;
      pendingApproval = { id, turnId, behavior };
      send({ id, method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId,
        itemId: `cmd-${turnId}`, command: behavior.bash, reason: "run a test" } });
      return;
    }
    afterTool(turnId, behavior);
  };

  return {
    onMessage(message, meta) {
      log({ op: "recv", method: message.method ?? "response", keys: Object.keys(message) });
      if (message.id !== undefined && !message.method && pendingApproval && message.id === pendingApproval.id) {
        const { turnId, behavior } = pendingApproval;
        pendingApproval = null;
        return shell(turnId, behavior, message.result?.decision);
      }
      if (message.id === undefined) return undefined;
      const params = message.params ?? {};
      if (message.method === "thread/start" || message.method === "thread/resume") {
        thread = params.threadId ?? thread ?? "thread-1";
        return send({ id: message.id, result: { thread: { id: thread, cwd: params.cwd } } });
      }
      if (message.method === "turn/start") return turn(message, meta);
      if (message.method === "turn/interrupt") {
        send({ id: message.id, result: {} });
        if (hanging) {
          send({ method: "turn/completed",
            params: { threadId: thread, turn: { id: hanging, status: "interrupted" } } });
          hanging = null;
        }
        return undefined;
      }
      return send({ id: message.id, result: {} });
    },
  };
}
