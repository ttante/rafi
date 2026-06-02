---
name: dependencies
category: process
description: "Dependency, license, SBOM, and vulnerability governance."
condition: always
template: false
---
## Dependency And Supply Chain Governance

- Do not add major dependencies, paid services, or vendor lock-in without a clear reason and user approval when the decision has meaningful cost, security, licensing, or maintenance impact.
- Prefer existing dependencies and standard library capabilities before adding new packages.
- Keep lockfiles committed and reproducible.
- Check dependency licenses before adding packages to production applications.
- Generate and maintain a software bill of materials for production applications where practical.
- Scan dependencies and container images for known vulnerabilities and address meaningful findings.
- Remove unused dependencies, stale packages, and abandoned integrations when discovered during relevant work.

