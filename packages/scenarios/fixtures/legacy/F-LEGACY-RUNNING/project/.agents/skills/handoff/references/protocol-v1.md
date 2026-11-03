# Rafi handoff protocol v1

At the next safe boundary, settle the current tool/action and emit exactly one envelope:

```text
RAFI_HANDOFF_REQUEST_START
{"version":1,"reason":"...","decisions":[],"constraints":[],"discoveries":[],"completed_actions":[],"evidence":[],"failures":[],"blockers":[],"open_work":[],"next_action":"...","role_state":{}}
RAFI_HANDOFF_REQUEST_END
```

The JSON must be a single object conforming to `manifest-v1.schema.json`.

- `reason` explains why a genuinely fresh session is needed.
- Record verified work and evidence precisely enough to avoid repeating side effects.
- Mark an uncertain in-flight operation as unknown; never infer completion.
- `next_action` must advance the frozen objective.
- Do not add `HANDOFF_ACCEPTED`; only a fresh successor can accept Rafi's published bundle.

After emitting the envelope, stop. Rafi may reject it, request a repair, pause a third consecutive unproductive request, or validate and transfer it.
