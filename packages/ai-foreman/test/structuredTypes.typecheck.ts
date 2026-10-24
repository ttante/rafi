/** Compile-only negative authority boundaries; intentionally never dispatched. */
import { validateStructuredCandidate, type OutputContract, type ProviderWireContract, type SelectedDispatchTupleV2, type StructuredResponse } from "rafi-spec";
import type { TurnResult, TurnPolicy } from "../src/adapters/types.js";
import type { ClaudeAdapter } from "../src/adapters/claude.js";
import type { CodexAdapter } from "../src/adapters/codex.js";
function authorityTypes(claude: ClaudeAdapter, codex: CodexAdapter, output: OutputContract,
  descriptor: ProviderWireContract, tuple: SelectedDispatchTupleV2, response: StructuredResponse): void {
  // @ts-expect-error A public output-bearing policy requires sealed identity and capability.
  const unsealedPolicy: TurnPolicy = { output };
  void unsealedPolicy;
  // @ts-expect-error Output-bearing transport cannot omit sealed capability, tuple and guidance.
  void claude.sendTurn("unsealed", { output });
  // @ts-expect-error Codex enforces the same sealed transport boundary.
  void codex.sendTurn("unsealed", { output });
  // @ts-expect-error Candidate validation requires its immutable selected dispatch tuple.
  validateStructuredCandidate(output, response, descriptor);
  // @ts-expect-error Structured results cannot lose their selected authority tuple.
  const unbound: TurnResult = { text: "", isError: false, numTurns: 1, costUsd: 0, structured: response };
  void unbound;
  // @ts-expect-error Result identity cannot be replaced after construction.
  ({} as TurnResult).selectedDispatch = tuple;
  // @ts-expect-error A sealed tuple identity is readonly.
  tuple.dispatchId = "replaced";
}
void authorityTypes;
