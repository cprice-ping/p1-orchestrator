# Personal fork changes

## 2026-09-24 — Reuse orchestrator OAuth for Authorize

Removed the separate PingCLI profile requirement. The Authorize adapter now uses
the orchestrator's existing in-memory PingOne OAuth token for Management API
requests. A direct bearer-token GET to Atlas `authorizationPolicies?limit=1`
returned HTTP 200 and one policy. The token remains in the server process; the
specialist's environment, mode, and operation guards remain active. No live
configuration changes were made.

## 2026-09-24 — Executable Authorize specialist

Added the complete EA skill and seven named references, an active authorize_policy
specialist, an OAuth-authenticated Authorize adapter, and Claude/Gemini engine
integration. The parent dispatcher supports inspect/author/deploy/evaluate modes;
delete remains a separate disabled-by-default operator capability. API calls are
bound to the configured environment allowlist, and full policy replacements check
fresh versions, retained children, exact Custom-node placement and readback.

Build and 13 focused tests pass. Four bounded collection reads, a direct API read
using the orchestrator OAuth token, and one Claude specialist read were live-verified
in the approved environment. No live changes, deletions, deployment or evaluation
occurred. See docs/PERSONAL_AUTHORIZE.md for exact evidence, configuration,
limitations and the next bounded verification.
