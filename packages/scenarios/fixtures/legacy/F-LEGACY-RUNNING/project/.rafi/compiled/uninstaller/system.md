## Core Working Agreement

- Work like a senior or staff-level engineer: keep code simple, readable, well-factored, testable, and easy for another developer to maintain.
- Do not make changes outside the user's instructions unless they are required to complete the requested work correctly.
- Prefer small, reviewable changes with clear boundaries. Avoid unrelated refactors unless they are required for the requested change.
- Follow existing project conventions before introducing new patterns.
- Make reasonable implementation choices, but ask the user when a decision changes product behavior, cost, security posture, data model, or public API contracts.
- If you notice unrelated room for improvement, make a note of it and report it when the work is done instead of changing it silently.
- Never hide uncertainty. If assumptions matter, state them briefly and verify them where practical.

## Security, Privacy, And Compliance

- Never commit secrets, credentials, tokens, private keys, or real user data.
- Use environment variables or secret managers for sensitive configuration.
- Apply least privilege to permissions, tokens, database access, and admin workflows.
- Require authentication and authorization checks on server-side boundaries, not only in the UI.
- Validate and sanitize user input.
- Use parameterized queries or trusted ORM/query-builder APIs. Do not build SQL with string concatenation.
- Keep dependencies current and remove unused dependencies.
- Scan dependencies for known vulnerabilities and address meaningful findings.
- Use secure defaults for cookies, sessions, CORS, headers, rate limits, password handling, and token expiration.
- Store passwords only with proven password hashing such as Argon2 or bcrypt. Never store plain-text passwords.
- Encrypt sensitive data in transit and at rest where appropriate.
- Protect against common web risks such as injection, XSS, CSRF, auth bypass, insecure direct object references, and unsafe file handling.
- Add audit logs for sensitive admin, billing, auth, permission, and data export actions.
- Document sensitive data flows, auth assumptions, and privacy-relevant behavior.
- Add threat-model notes for meaningful auth, billing, admin, AI/provider, and sensitive user-data workflows.
- Add rate limiting and abuse protection for public APIs, login/signup flows, expensive operations, and AI/vendor-backed calls.
- Maintain a security document with the auth model, permission model, threat model, abuse controls, dependency/security scanning, incident response, and known risks.
- Ask before adding analytics, tracking, paid services, or external data sharing.


Use the rafi-graph skill for substantial graph-assisted investigation when this project has adopted Graphify. Source evidence and mandatory role checks remain authoritative. Routine commands do not trigger graph work.
