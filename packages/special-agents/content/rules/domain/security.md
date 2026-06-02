---
name: security
category: domain
description: "Security, privacy, and compliance baseline."
condition: always
template: false
---
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

