# Personal fork decision: Authorize through PingCLI-managed API access

Date: 2026-09-24. Scope: the personal fork's Authorize specialist.

The remote MCP catalog does not supply the assumed full Authorize EA surface.
Dedicated CLI commands also omit policy tree and Trust Framework operations.
The generic PingCLI management API command successfully reads Authorize policies,
attributes, services, and Decision Endpoints using its configured authentication.

Use a dedicated adapter for this specialist, with fixed resource routes, explicit
profile/environment configuration, private JSON body files and error-aware CLI
envelope parsing. Keep the existing upstream fallback implementation unchanged.
The complete EA skill is loaded as domain context, with named reference retrieval.
Both model engines call the same adapter. No third PingOne authentication mechanism
or administrative token handling is added to the agent.

The parent dispatch defaults to inspect; author/deploy/evaluate modes and deletion
have separate operator capability checks. Writes are implemented and mock-tested,
not live verified by this change. Existing unrelated specialists retain their
behavior. The older draft PR is not updated by this personal branch.
