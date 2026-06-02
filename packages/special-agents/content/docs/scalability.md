# Scalability Plan

Use this document to describe how the app should scale locally, in cloud environments, and across major system areas.

## Current Status

- Expected users:
- Expected data size:
- Expected request volume:
- Expected AI/model volume:
- Expected cost constraints:
- Last reviewed:

## Local And Cloud Runtime

Unless the project says otherwise, the app should run both locally and in the cloud.

| Environment | Runtime Path | Dependencies | Data Strategy | Known Gaps |
|---|---|---|---|---|
| Local development | `<command/docker/etc>` | `<services>` | `<seed/local db>` | `<gaps>` |
| Cloud | `<provider/services>` | `<services>` | `<managed db/storage>` | `<gaps>` |

## Server Scaling

- Stateless services:
- Horizontal scaling plan:
- Background job strategy:
- Queueing strategy:
- Rate limiting:
- Caching:
- Bottlenecks:

## Cloud Scaling

- Default cloud provider:
- Infrastructure as Code tool:
- Regions:
- Managed services:
- Deployment topology:
- Autoscaling assumptions:
- Capacity limits:
- Failover expectations:

## Frontend Scaling

- Bundle-size strategy:
- Rendering/performance risks:
- Loading-state strategy:
- Mobile performance:
- Caching:
- Network request strategy:

## Database Scaling

- Schema growth assumptions:
- Index strategy:
- Query risk areas:
- Read/write volume:
- Connection management:
- Migration strategy:
- Archival/retention strategy:

## AI And Model Scaling

- Provider limits:
- Latency expectations:
- Concurrency strategy:
- Queueing/fallback behavior:
- Cost controls:
- Model upgrade path:
- Eval impact of model changes:

## Total Architecture Scaling

| Area | Current Limit | Scale Trigger | Planned Response | Owner |
|---|---|---|---|---|
| `<area>` | `<limit>` | `<trigger>` | `<response>` | `<owner>` |

## Open Risks

- `<risk>`
