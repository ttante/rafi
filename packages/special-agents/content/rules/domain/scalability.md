---
name: scalability
category: domain
description: "Scaling strategy across server, cloud, AI, frontend, and data."
condition: always
template: false
---
## Scalability And Performance

- Plan for scalability across the server, cloud infrastructure, AI/model usage, frontend, databases, and total app architecture.
- Keep services stateless where practical so they can scale horizontally.
- Use pagination, filtering, caching, batching, queues, background jobs, and rate limits where they reduce load or improve user experience.
- Design database schemas, indexes, constraints, and query patterns with expected growth in mind.
- For frontend work, watch bundle size, rendering cost, loading states, network waterfalls, and mobile performance.
- For cloud infrastructure, document scaling assumptions, capacity limits, deployment topology, regions, managed services, and expected bottlenecks.
- For AI/model usage, plan for provider limits, latency, concurrency, queueing, fallback behavior, cost controls, and model upgrade paths.
- Document meaningful scalability assumptions and known limits in `docs/scalability.md`.

