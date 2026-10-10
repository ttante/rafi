---
name: rafi-graph
description: Use adopted Rafi Graphify evidence for explicit graph requests and substantial architecture, dependency, impact, or cross-file investigations. Routine file lookups, tests, formatting, ticket bookkeeping, and handoff alone do not qualify.
---

Use graph evidence as source navigation. Verify claims in the actual source and preserve every required implementation, preparation, QA, and review check. Distinguish structural facts from inferred semantic relationships; report stale, missing, partial, ambiguous, or unavailable evidence accurately.

In a hosted Rafi phase, use the host-provided graph packet. If more evidence is needed, return one strict JSON business object:

```json
{"kind":"rafi_graph_request","version":1,"requestId":"dependencies-1","operations":[{"operation":"query","query":"specific affected components"}]}
```

Put required continuity records outside that JSON. Do not mix an evidence request with a completion status or QA verdict. Follow the host's continuation under the same task authority; do not repeat completed edits. Response-only correction, contract acceptance, and semantic extraction turns cannot request graph work. Manager uses its separately supplied tagged evidence protocol.

In a native Claude or Codex session, no orchestration exchange is implied. When the existing permissions allow it, use `rafi graph query "concept" --project . --json`, `rafi graph node NODE --project . --json`, or `rafi graph impact NODE --project . --json`. `neighbors` and `path` also accept `--direction incoming|outgoing|both`. Never substitute arbitrary Python, shell fragments, graph paths, or another project's configuration for unavailable access.

Missing adoption requires the user's explicit `rafi graph adopt` decision. Reads never install, refresh, or create a graph. Disabled policy wins over old packets, sessions, and skills. A host-write prohibition permits only nonmutating reads and in-memory results.

After a meaningful completed editing task under adopted selective maintenance, use one stable task ID with `rafi graph refresh --task ID`. Do not refresh after each tool, test, ticket update, or handoff. Mixed corpora require an authorized host semantic exchange; follow the CLI's captured-input exchange and preserve incomplete coverage if the host is unavailable. Do not infer permission for external semantic backends from installed tools or API keys. Carry evidence references and limitations into a handoff without refreshing merely to hand off.
