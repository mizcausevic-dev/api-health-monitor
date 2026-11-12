# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Please do not open a public issue for a security problem. Expect an acknowledgement within 5 business days.

## Scope

In scope: the API server (`src/`), the dashboard (`public/`), the build scripts (`scripts/`) and the GitHub Actions workflows.

Particularly interesting:

- ways to make the checker reach a private, loopback or link-local address while `AHM_ALLOW_PRIVATE_TARGETS=false`
- script execution in the dashboard from data returned by a monitored server
- write access without the API key, or reading another principal's idempotency results
- anything that makes the GitHub Pages snapshot publish data it should not, including a secret value that passes the build's secret gate
- forging or replaying an incident webhook that verifies against the `whsec_` secret, or making a webhook reach a private address

Out of scope: denial of service by a holder of the API key (the key is an operator credential), and findings that require `AHM_ALLOW_PRIVATE_TARGETS=true` or `AHM_TRUST_PROXY=true` on an untrusted network, since both are documented as operator opt-ins.

## Design notes

The threat model and controls are summarised in the README's "Security model" section.
