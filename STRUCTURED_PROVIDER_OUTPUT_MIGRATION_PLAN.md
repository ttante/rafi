# Rafi Structured Provider Output Migration Plan

## Purpose

Rafi currently asks providers to return machine-readable JSON inside text markers such as:

```text
RAFI_TICKET_POPULATION_PROPOSAL_START
{ ... }
RAFI_TICKET_POPULATION_PROPOSAL_END
```

This works across Claude and Codex, but it makes a provider formatting mistake look like a workflow failure. It also causes avoidable repair turns, repeated reviews, and latency.

The goal is to make machine payloads structured-first while preserving strict validation, durable raw evidence, provider portability, and safe fallback behavior.

## Desired end state

Every provider operation has two separate channels:

1. **Machine channel:** one provider-native structured object or tool result, validated against a Rafi schema before it can affect state.
2. **Human channel:** optional prose summary, status, explanation, or continuation text that is never parsed as authoritative state.

Rafi must never infer authoritative JSON from arbitrary prose when a structured result is required.

## Current problems confirmed in the codebase

- Major workflows use text envelopes: planning, ticket planning, ticket population, discovery, source requests, handoffs, QA coverage, QA failure reports, remediation, and audit outputs.
- Claude and Codex adapters currently return provider text; the operation layers perform extraction and schema validation afterward.
- Envelope validation is strict, but the provider is only instructed—not technically forced—to emit the envelope.
- Repair behavior is inconsistent. Planning and QA have bounded repair/review paths; ticket population rejected Codex immediately when the JSON lacked its required markers.
- The raw provider response is generally retained, which is good for auditability, but the response format itself is not normalized across operations.

## Non-goals

- Do not weaken schema validation.
- Do not accept arbitrary JSON found in prose as an automatic success path.
- Do not discard raw provider responses or validation diagnostics.
- Do not migrate all workflows in one large change.
- Do not make provider-native features a hidden requirement without a compatible fallback.

## Architecture changes

### 1. Define one provider-output abstraction

Add a shared output contract used by Claude and Codex adapters:

```ts
type ProviderStructuredResult = {
  schemaId: string;
  payload: unknown;
  rawText?: string;
  providerTurnId?: string;
  transport: "native-structured" | "tool-result" | "legacy-envelope";
};
```

The operation layer should receive a structured result, not independently search raw text for markers.

The abstraction must retain:

- raw response digest and content;
- provider/session/turn identity;
- schema identifier and schema revision;
- transport used;
- parse/validation diagnostics;
- repair attempts, if any.

### 2. Add provider-native structured-output capability detection

Extend `BuilderAdapter` capabilities with an explicit result mode, for example:

```ts
structuredOutput: {
  supported: boolean;
  mode?: "json-schema" | "tool";
  maxSchemaBytes?: number;
}
```

Claude and Codex adapters must report capability from the actual runtime/API path. Do not assume that a provider name implies support.

Each structured operation should provide:

- a stable schema ID;
- a JSON Schema generated from the canonical Zod schema where possible;
- a strictness mode;
- the expected top-level result type.

If the runtime cannot provide native structured output, the adapter must explicitly report the fallback mode.

### 3. Make the machine payload the primary request

For structured-capable providers, send the schema through the provider’s native structured-output or tool mechanism. The prompt should describe the task and constraints, but should not require the provider to manually type delimiters.

The provider’s prose response must not be parsed for authoritative state when a native structured result was requested.

### 4. Keep envelopes only as a compatibility fallback

For providers or runtime versions without native structured output:

- retain the existing marker format temporarily;
- centralize extraction in one shared parser;
- require exactly one envelope;
- validate the enclosed object against the operation schema;
- preserve the raw response;
- record `transport: "legacy-envelope"`.

Do not create new marker protocols after this migration begins.

### 5. Standardize one bounded format-repair policy

When fallback parsing fails for a correctable formatting reason—such as missing markers but otherwise recoverable output—Rafi may issue exactly one response-only repair turn:

> Resend the same machine payload using the required structured format. Do not change its substantive contents, inspect files, run tools, or perform work.

The repair must include the parser’s exact validation error. The original response remains authoritative evidence of what happened; the repaired response is accepted only after normal schema and binding validation.

No repair should occur for:

- schema/content errors requiring new reasoning;
- binding or identity mismatches;
- failed provider turns;
- evidence claims that cannot be verified;
- security or scope violations.

If the repair fails, the workflow pauses or enters its existing recovery path. It must not silently retry indefinitely.

### 6. Separate status from payload

`STEP_STATUS` and similar markers should become transport metadata where the provider/runtime supports it. Until then, parse status independently from the machine payload and persist both records separately.

The payload must never be considered valid merely because a status line says `done`.

## Migration order

### Phase 0: Inventory and shared foundation

- Enumerate every provider operation and its current envelope/parser.
- Assign stable schema IDs and revisions.
- Add shared result, capability, diagnostic, and repair-attempt types.
- Add contract tests for exactly-one-result, duplicate-result, missing-result, malformed-result, schema-invalid, and binding-invalid cases.
- Keep all existing behavior unchanged.

### Phase 1: Migrate low-risk planning outputs

Migrate structured plan and ticket-plan proposals first because they already have validation and bounded correction loops.

- Native structured result when supported.
- Legacy envelope fallback otherwise.
- Reuse the existing correction loop through the shared abstraction.
- Confirm plan identity, revision, digest, and source bindings after parsing.

### Phase 2: Migrate ticket population

This directly addresses the Codex failure.

- Add native structured population output.
- Add one format-only repair for legacy fallback responses.
- Preserve the failed raw response and the corrected response in the interview evidence.
- Keep the existing strict population schema and atomic publication.
- Add live/provider-fixture tests for missing markers, malformed JSON, valid JSON, duplicate payloads, and schema violations.

### Phase 3: Migrate QA and handoff outputs

Migrate QA coverage, failure reports, remediation reports, handoff requests, and acknowledgements only after the shared transport is proven.

Special requirements:

- Preserve session, source, review-basis, contract, and attempt bindings.
- Keep canonical final coverage assembly in one host-owned function.
- Never let a repaired response replace missing host evidence.
- Keep the current durable receipt and raw-response checks.

### Phase 4: Migrate discovery, source requests, audits, and remaining operations

Move the remaining marker protocols to the same abstraction. Remove individual extraction implementations only after their callers and fixtures use the shared path.

### Phase 5: Deprecate and remove legacy envelopes

After all supported runtimes use native structured output or a controlled tool result:

- stop generating new envelope instructions;
- retain read-only parsing for historical evidence;
- remove legacy write paths only in a versioned breaking change;
- document the minimum provider/runtime capability required.

## Evidence and persistence requirements

Every structured exchange must durably retain:

- raw provider response digest;
- raw response content or durable evidence reference;
- structured payload digest;
- schema ID and revision;
- transport mode;
- provider/session/turn identity;
- validation result and exact errors;
- repair relationship, if a repair occurred;
- final accepted payload digest.

The accepted payload must remain bound to the same workflow identity rules already used for QA certificates and ticket publication.

## Performance improvements

Measure before and after migration:

- provider turns per successful workflow;
- format-repair turns;
- full review retries;
- tokens and cost per workflow;
- wall-clock time spent waiting on provider responses;
- percentage of responses using native structured output;
- percentage falling back to envelopes;
- malformed-output rate by provider and operation.

Native structured output should reduce formatting repairs and repeated prompts. It will not remove provider reasoning time, tool execution time, or legitimate QA retries; those must remain separately measured.

## Regression safeguards

- Run the existing focused contract, QA, ticket-population, handoff, and recovery suites at every migration phase.
- Run online Claude and Codex journeys in isolated workspaces with durable evidence ledgers.
- Require at least one successful native-structured and one legacy-fallback journey for each migrated operation until fallback removal.
- Verify that malformed provider output never mutates tickets, plans, certificates, source files, or workflow state.
- Verify that raw evidence survives failed parsing and repair.
- Verify that duplicate or conflicting structured results are rejected.
- Verify that a repaired payload cannot change substantive content without detection.
- Keep provider capability and transport mode visible in logs and final workflow diagnostics.

## Recommended implementation priority

1. Shared structured-result abstraction and capability reporting.
2. Ticket-population native output plus one format-only repair.
3. Planning and ticket-plan migration.
4. QA/handoff migration with existing evidence bindings preserved.
5. Remaining workflows and legacy-envelope deprecation.

The immediate practical fix is not to delete the wrappers. It is to stop making them the primary machine interface, while retaining them as a strict, auditable fallback until native structured output is proven across both providers.


codex -C . --sandbox workspace-write --ask-for-approval on-request

Then say: “Read LIVE_E2E_EXECUTION_HANDOFF.md and run both live E2Es in parallel. Ask me for approval when needed