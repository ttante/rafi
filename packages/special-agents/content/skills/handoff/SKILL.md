---
name: handoff
description: Stage a structured cumulative Builder handoff when Rafi requests one or when the Builder must explicitly request a fresh session. Do not use for ordinary progress summaries.
---

# Handoff

Use this skill only at a safe action boundary. Produce staged structured output; Rafi validates it, publishes durable content, starts the successor, and moves ownership.

- Never claim that a handoff completed or start, resume, close, or transfer a session yourself.
- Include cumulative facts needed to continue, including earlier decisions and failures—not only the last turn.
- Do not include credentials, hidden reasoning, raw transcripts, or unbounded logs.
- An ordinary summary is not a handoff request.

For a host-requested handoff or a Builder-requested transfer, read [references/protocol-v1.md](references/protocol-v1.md). Use [references/manifest-v1.schema.json](references/manifest-v1.schema.json) as the exact staged-output schema.
