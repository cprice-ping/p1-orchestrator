# Authorize specialist

Status: implemented. OAuth transport has passed a bounded
direct Atlas API read and a Claude specialist read (2026-09-24). No live writes,
deletions, deployment, or evaluation were performed. No tenant configuration or
credentials are included in this repository.

## What is included

`authorize_policy` is an active specialist, with the EA Authorize skill loaded as
its system context and all seven full references available through a fixed
`authorize_reference` tool. It replaces the inventory-only draft.
The older `docs/authorize-specialist/` material describes the earlier PR draft.

The specialist has three internal tools:

- `authorize_read`: policies, attributes, services, authorization versions, API
  Servers/operations, Decision Endpoints, recent decisions, deployment and tags.
- `authorize_change`: create, replace, delete, tag, attach, deploy and direct
  evaluate, subject to the dispatch mode and operator capabilities.
- `authorize_reference`: read a named skill reference without shell/file access.

The parent MCP client still sees the existing three-tool directory/dispatch/env
lookup interface. `dispatch_specialist` now accepts `authorizeMode`.

## Authentication and execution

The Authorize path uses the same OAuth token that the orchestrator uses to call
the PingOne MCP server. The token stays in the orchestrator process and is sent
only to the regional PingOne Management API endpoint selected from `P1_MCP_URL`.
The model never receives it. User roles and permissions govern the Management API
request; the specialist's environment allowlist and mode checks still apply.

Authorize now requires the standard `P1_MCP_URL` so the orchestrator can sign in
to the configured administrator environment and select the matching API region.
The task environment is supplied explicitly or through `P1_ENVIRONMENT_ID` and
must be in `AUTHORIZE_ENVIRONMENTS` for `author`, `deploy` and `evaluate`.
Read-only `inspect` works without any Authorize configuration, like every other
specialist; if `AUTHORIZE_ENVIRONMENTS` is set, it pins `inspect` too. There is
no separate PingCLI profile.
Both Claude and Gemini use the same Authorize runtime and permission checks; only
Claude has a live model-dispatch verification here.

The Claude engine still requires its own existing model authentication. Gemini
requires `GEMINI_API_KEY`. Model authentication is separate from PingOne
administrative authentication; no new model subscription is provisioned.

## Configuration

Install Node 22+ and configure the standard PingOne MCP URL. From this checkout:

```sh
npm ci
npm run build
npm test
```

Provide configuration to the server process, not through model tool arguments:

| Variable | Purpose |
|---|---|
| `P1_MCP_URL` | Standard PingOne MCP endpoint; its administrator environment is used for OAuth login and its region selects the Management API host |
| `AUTHORIZE_ENVIRONMENTS` | Comma-separated exact environment UUID allowlist. Required for `author`/`deploy`/`evaluate`; optional for `inspect` (pins it when set) |
| `P1_ENVIRONMENT_ID` | Default dispatch target UUID |
| `AUTHORIZE_CAPABILITIES` | Enabled modes; default `inspect`. Can include `author,deploy,evaluate`; omit `delete` to disable all deletions |
| `SPECIALIST_ENGINE` | `claude` (default) or `gemini` |
| `P1_SPECIALIST_MODEL` | Optional configured model override |

The orchestrator performs its normal PingOne OAuth sign-in and keeps tokens in
process memory. Never place bearer tokens in prompts or request bodies. Do not
copy another tenant's identifiers.

Attach `node /absolute/path/to/this/checkout/dist/server.js` as a stdio MCP server
in your client, with the variables above. Paths here are examples, not hardcoded
runtime dependencies. `knowledge/` and `specialists/` must remain beside `dist/`.

Example dispatch (substitute an allowed environment):

```json
{
  "specialist": "authorize_policy",
  "environmentId": "<environment-id>",
  "authorizeMode": "inspect",
  "intent": "Read one policy page with limit 1 and report what was inspected. Make no changes."
}
```

For an authorized configuration task use `author`; for version tagging/attachment
or AAM deployment use `deploy`; for a direct decision request use `evaluate`.
Each mode must also be enabled by the operator. An agent-supplied mode is not human
approval: the calling agent must stay within the user's task authorization.
`allowDestructive` alone cannot enable deletion; the operator must separately
include `delete` in capabilities.
An `author` edit can affect an always-current endpoint immediately even without
an explicit deployment, so inspect effective bindings first.

## Verification

- `npm run build`: pass.
- `npm test`: 21 focused tests pass, including MCP stdio discovery, mode rejection
  before authentication, regional URL validation, OAuth header handling and redaction,
  environment/schema boundaries, fresh versions, Custom child preservation/parent
  links, readback mismatch, output sanitization, formatted JSON-string payloads,
  the inspect-without-allowlist default, and gate refusals reported separately
  from API errors.
- Direct token check: the orchestrator OAuth flow in the existing administrator
  environment returned HTTP 200 for one Atlas `authorizationPolicies?limit=1` GET.
  Only status and result count were printed.
- Installed MCP check: one `authorize_policy` dispatch made exactly one read
  through the shared OAuth token and returned successfully. No CLI profile was
  present in the server configuration.
- Live read-only adapter check: policies (1), attributes (1, next page present),
  services (0), Decision Endpoints (3). Requests use limit 1 where accepted; the
  endpoint collection returned 3, so collection limits are not assumed universal.
- Live Claude dispatch: exactly one `authorize_read` call, one policy object
  returned, explicit no-change report, successful run in roughly 10 seconds.
- Gemini code path compiles and shares the tested runtime; no live Gemini model
  call was run. Configuration mutations/deployment/evaluation are mock-tested only.

`npm run authorize:check` runs only bounded reads, uses the orchestrator OAuth
session and allowed environment, and prints collection counts rather than raw
payloads. It is a transport check, not a model or policy-enforcement test.

## Operational behavior and limits

- Fresh Authorize dispatches bind a single target and mode. Session resume is
  rejected; send a sanitized prior summary in a new intent.
- Full policy replacements require fresh object/rule versions. Existing children
  cannot be removed without deletion capability. Managed ancestors are rejected;
  only an eligible exact `Custom` container can accept new POLICY children, while
  retaining existing children unchanged. Parent and new child links are read back.
- Requested-field mismatches and failed deployment verification mark the tool/run
  incomplete. The dispatch result lists gate refusals (environment, mode,
  capability, delete authorization) as `REFUSED by orchestrator gate` and other
  failures (API errors, validation, readback) as `tool error (not a gate
  refusal)`, so the operator can tell "stop and ask" from "inspect and retry". Configuration readback does not prove a live decision or enforcement.
- API errors withhold response bodies and never relay bearer tokens. There are no
  automatic mutation retries.
  A timeout after a write is an ambiguous outcome: read state before retrying.
- Credentials in recognized fields, bearer/JWT strings, and JSON-encoded traces
  are redacted; raw tool arguments/results and final reports are not written to
  the adapter audit log. Arbitrary application-defined secret constants cannot
  be inferred reliably; configure secret definitions outside model context and
  use their IDs. The model provider receives sanitized tool results and may retain
  its own session records under its normal data handling.
- Generic API request schemas preserve the vendor's full JSON payload flexibility;
  this is not a complete local validator of every EA field or business rule.
- Native MCP Authorize tools are not auto-selected by matching names. Adopting a
  future native tool requires explicit schema/behavior review.
- This adapter uses the management API; gateway Sideband proofs and external
  issuer credentials are separate integrations, not simulated by a direct call.

Next verification: a separately authorized, narrowly named policy canary with
configuration readback and, if requested, runtime tests. Do not change or delete
existing Atlas resources merely to exercise the implementation.
