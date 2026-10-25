# Native handoff request

At a safe action boundary, choose the `handoff-request` result in the host-selected native output schema. Supply `reason` and `roleState.summary`. Include the required bounded `continuity` object beside `result`, retaining verified decisions, constraints, discoveries, completed actions, evidence, failures, blockers, open work and next action.

Do not emit delimiters, a status suffix or an acceptance acknowledgement. Do not transfer sessions yourself. Stop after submitting the request. Rafi validates the request, freezes the objective, stages the durable packet and validates a fresh successor before moving ownership. A rejected or incomplete acknowledgement leaves the existing owner in place.

Record uncertain operations as uncertain; never infer completion. Preserve enough source and receipt references to avoid repeating side effects. Exclude credentials, hidden reasoning and unbounded transcripts.

Only a fresh successor may acknowledge the host-selected `handoff-acceptance` operation. It must return the exact manifest digest and generation, identify missing resources, and include continuity. This proves receipt, not implementation success or independent QA.
