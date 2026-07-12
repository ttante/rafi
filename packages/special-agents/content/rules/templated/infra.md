---
name: infra
category: templated
description: "Local/cloud runtime parity and infrastructure-as-code expectations."
condition: cloud
template: true
---
## Infrastructure And Local/Cloud Runtime

- Unless otherwise noted, build applications to run locally and in the cloud.
- Keep local and cloud environments as similar as practical while documenting intentional differences.
- Provide a local runtime path using Docker Compose, local services, scripts, or equivalent tooling when the app has service dependencies.
- Keep `.env.example`, setup docs, seed data, and local database instructions current.
- Define cloud infrastructure with Infrastructure as Code such as AWS CDK, Terraform, Pulumi, or CloudFormation unless there is a documented reason not to.
- Avoid manual cloud console changes for durable infrastructure. If manual changes are unavoidable, document them and add follow-up work to codify them.
- Document {{cloud}} account/region assumptions, IAM model, networking, secrets, storage, databases, queues, observability, and deployment flow in `{{docsRoot}}/local-cloud.md`, `{{docsRoot}}/architecture.md`, or `{{docsRoot}}/operations.md`.
- Consult the user when local/cloud runtime expectations, hosting constraints, or infrastructure ownership are unclear.

