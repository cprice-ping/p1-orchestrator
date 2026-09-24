# Decision: Authorize through the Management API with the orchestrator's OAuth token

Date: 2026-09-24. Scope: the `authorize_policy` specialist.

The remote MCP catalog does not supply the full Authorize EA surface, and the
dedicated `pingcli` commands omit the policy tree and Trust Framework operations.
The first version of this specialist therefore went through the generic
`pingcli pingone api` command with its own CLI profile.

That was replaced before merge. The specialist now calls the regional PingOne
Management API directly from the orchestrator process, using the same in-memory
OAuth token the orchestrator already holds for the PingOne MCP server:

- No second PingOne credential: no CLI profile, no worker secret, nothing on disk.
  The token never leaves the orchestrator process and is never shown to a model.
- Requests are built from fixed resource routes with UUID-validated IDs and must
  stay on `/v1/environments/...` of the region selected from `P1_MCP_URL`. The
  model cannot supply URLs, methods, headers or CLI arguments.
- Both model engines call the same adapter and the same gates.

The parent dispatch defaults to read-only `inspect`, which needs no configuration.
`author`, `deploy` and `evaluate` must be enabled in `AUTHORIZE_CAPABILITIES` and
target an environment listed in `AUTHORIZE_ENVIRONMENTS`. Deletion additionally
needs the `delete` capability and `allowDestructive` on the dispatch. Writes are
implemented and mock-tested; live verification covers reads only. Other
specialists keep their existing behavior.
