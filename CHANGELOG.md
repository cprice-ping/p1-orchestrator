# Changes

## 2026-09-24 — Authorize review fixes

- Write bodies are checked for secrets field by field. The previous check compared
  re-serialized copies, so a statement payload holding formatted JSON (for
  example `'{"a": 1}'`) was rejected as a secret.
- Gate refusals (environment, mode, capability, delete authorization) are now a
  distinct error type. The dispatch result lists them as `REFUSED by orchestrator
  gate` and lists API, validation and readback failures separately as
  `tool error (not a gate refusal)`. Before, every tool error was shown as a
  gate refusal.
- `inspect` no longer needs `AUTHORIZE_ENVIRONMENTS`: it runs on the dispatch's
  environment like other specialists, and is still pinned when the allowlist is
  set. `author`, `deploy` and `evaluate` still require the environment to be listed.
- Documentation no longer describes this as a personal fork; the decision record
  now describes the OAuth approach that shipped. 21 tests pass.

## 2026-09-24 — Authorize author-mode tool discovery and run evidence

Changed `authorize_change`'s body schema to a passthrough object. With the
installed Claude Agent SDK, the previous Zod record schema made the child MCP
server's `tools/list` fail, leaving author-mode runs with no tools. A local
in-memory MCP test now checks that all three author tools list successfully.

Authorize dispatches now record only safe SDK event structure and MCP connection
status, plus change attempts and readback verification counts. A text-only run
with zero tool calls, or an author run that stops before `authorize_change`, is
reported as incomplete instead of success. A configuration change without
verified readback is also reported as incomplete, with an inspect-before-retry
message. Build, typecheck, and 18 mocked tests pass. No live PingOne write or
decision evaluation was performed; existing MCP processes require reconnect.

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
occurred. See docs/AUTHORIZE.md for exact evidence, configuration,
limitations and the next bounded verification.
