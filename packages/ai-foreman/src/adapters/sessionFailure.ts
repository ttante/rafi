import type { SessionAvailabilityV1 } from "rafi-spec";
import type { RuntimeFailure, SessionFailurePhase, TurnDispatchState, TurnResult } from "./types.js";

export class SessionUnavailableError extends Error {
  readonly failure: RuntimeFailure;

  constructor(input: {
    runtime: "claude" | "codex";
    phase: SessionFailurePhase;
    dispatchState: TurnDispatchState;
    executable: string;
    cwd: string;
    diagnostics: string;
    availability?: SessionAvailabilityV1;
    cause?: unknown;
  }) {
    super(input.diagnostics, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "SessionUnavailableError";
    this.failure = {
      runtime: input.runtime,
      phase: input.phase,
      category: "session-unavailable",
      executable: input.executable,
      cwd: input.cwd,
      diagnostics: input.diagnostics,
      dispatchState: input.dispatchState,
      ...(input.availability ? { availability: input.availability } : {}),
    };
  }
}

export function sessionUnavailableResult(error: SessionUnavailableError): TurnResult {
  return {
    text: error.message,
    isError: true,
    numTurns: 0,
    costUsd: 0,
    costAuthoritative: false,
    failure: error.failure,
  };
}

export function isSessionUnavailableFailure(value: unknown): boolean {
  if (value instanceof SessionUnavailableError) return true;
  if (!value || typeof value !== "object") return false;
  const failure = "failure" in value ? (value as { failure?: RuntimeFailure }).failure : value as RuntimeFailure;
  return failure?.category === "session-unavailable";
}

export function sessionUnavailableErrorFromFailure(failure: RuntimeFailure): SessionUnavailableError {
  if (failure.category !== "session-unavailable") throw new Error("runtime failure is not a session-unavailable failure");
  const phase = failure.phase === "preflight" || failure.phase === "attach" || failure.phase === "turn"
    ? failure.phase
    : "turn";
  return new SessionUnavailableError({
    runtime: failure.runtime,
    phase,
    dispatchState: failure.dispatchState ?? "unknown",
    executable: failure.executable,
    cwd: failure.cwd,
    diagnostics: failure.diagnostics,
    availability: failure.availability,
  });
}
