# p1-orchestrator

**The specialist approach to the PingOne MCP Server: make sense of 78 raw
tools with a handful of purpose-built agents.**

The P1 MCP server exposes 78 tools spanning every service — right for a
generalist human, a poor fit for an agent doing real work: every tool schema
rides in context every turn, tool descriptions say what but not how, and
cross-service flows (scopes live on Resources, granted to Applications via a
second call) are tribal knowledge each consumer rediscovers.

This repo inverts the ratio. It is a small **orchestrator MCP server** that
exposes ~4 tools. Each is a *specialist* — a bounded agent loop holding a
curated subset of the raw tools plus a **playbook**: the procedure, written
down. "Onboard an OIDC application" becomes one intent, not six raw calls
and guesswork.

```
Claude Code (or any MCP client)
    │  sees 4 one-liners — not 78 schemas
    ▼
p1-orchestrator  (this repo: one local MCP server)
    │  per call: spawn loop → playbook + tool subset → compact report
    ▼
PingOne MCP Server  (unchanged, raw tool supply)
```

**Demo scope, on purpose:** this runs as a *local* MCP server for one admin.
The auth and tool execution are bounded by PingOne itself (admin permissions,
per-environment MCP enablement, secret refusal) — this layer adds narrowing,
never bypass. Multi-user hosting is deliberately out of scope here; it is a
product/deployment decision, not a pattern requirement. The graduation path
(per-user tokens against a configured login env, ingress auth, a destructive-op
deny-gate) is sketched in `p1-orchestrator-proposal.html`.

## Quick start

```bash
npm install

# 1. One-time browser login (pre-wired pingone-mcp-server client,
#    OIDC code + PKCE — the same auth the P1 MCP Server performs).
#    Token is cached at ~/.p1-orchestrator/tokens.json and refreshed.
npm run login

# 2. Drive one specialist directly (no MCP layer) — the fast dev loop:
P1_ENVIRONMENT_ID=<target-env-uuid> \
npm run probe -- app_onboarding \
  "Create an OIDC web app named demo-app with scopes openid profile email,
   PKCE enforced, redirect http://localhost:3000/callback, enabled"

# 3. Attach the orchestrator to Claude Code:
npm run build
claude mcp add p1-orchestrator \
  --env P1_ENVIRONMENT_ID=<target-env-uuid> \
  -- node "$(pwd)/dist/server.js"
```

Env vars: `P1_MCP_URL` (defaults to the admin-env URL baked from this demo's
tenant), `P1_ENVIRONMENT_ID` (task-target env; specialists never search for
it), `P1_SPECIALIST_MODEL`, `SPECIALIST_ENGINE`.

## Engines — the registry is model-independent

`SPECIALIST_ENGINE` picks the loop runtime; the playbooks, tool subsets, and
descriptions are identical data either way:

| Engine | Loop runtime | Config |
|---|---|---|
| `claude` (default) | Agent SDK loop (bundled headless runtime; no CLI install needed) | inherits `ANTHROPIC_MODEL` / org gateway |
| `gemini` | plain function-calling loop, `@google/genai` | `GEMINI_API_KEY` |

The Gemini engine exists as the portability proof: same registry, ~200 lines
of loop, and the tool subset is *the request itself* (no deny-list needed).

## Adding a specialist — write one JSON file, nothing else

A specialist is a single `*.specialist.json`:

```json
{
  "name": "audit_investigator",
  "description": "One line — the only thing the orchestrator routes on.",
  "requires": [],
  "topics": ["audit-activities"],
  "tools": ["searchAuditActivities", "getAuditActivity"],
  "playbook": "You are the … (procedure, not vibes)",
  "fallback": { "listRiskPolicySets": { "args": ["pingone", "protect", "risk-policy-sets", "list"] } }
}
```

Two directories hold them:

- **`specialists/` in the repo** — shipped defaults, versioned with the code.
- **`~/.p1-orchestrator/specialists/`** — your drop-ins; a drop-in overrides a
  same-name default. Reloaded on a 30s TTL: file appears, next dispatch finds
  it, no server restart, no client reconnect, no recompile.

## What's here

| File | Role |
|---|---|
| `src/registry.ts` | **The transferable artifact.** Loads specialists from JSON: shipped defaults in `specialists/`, plus local drop-ins. |
| `src/launch.ts` | Engine dispatch + the Claude-engine loop: live catalog fetch, deny-complement filtering, resume. |
| `src/engines/gemini.ts` | The Gemini-engine loop over the same registry. |
| `src/engines/mcp-client.ts` | Shared stateful MCP client (initialize / tools/list / tools/call). |
| `src/auth.ts` | P1 OAuth: pre-wired client, browser once, cached + refreshed. |
| `src/server.ts` | The orchestrator MCP server (progress notifications, run-log paths). |
| `src/login.ts` · `src/probe.ts` · `src/p1-probe.ts` | One-time login · direct specialist runner · raw connectivity probe. |
| `p1-orchestrator-proposal.html` | The product-team writeup: problem, pattern, live-tenant evidence, asks. |

## Visibility

Every specialist run emits three lenses: live MCP progress events (tool calls
with arg previews, as they happen), a per-run NDJSON audit log at
`~/.p1-orchestrator/runs/`, and a resumable `session_id` for post-hoc
interrogation of the specialist's own reasoning.
