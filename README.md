# p1-orchestrator

**The specialist approach to the PingOne MCP Server: make sense of 78 raw
tools with a handful of purpose-built agents.**

The P1 MCP server exposes 78 tools spanning every service — right for a
generalist human, a poor fit for an agent doing real work: every tool schema
rides in context every turn, tool descriptions say what but not how, and
cross-service flows (scopes live on Resources, granted to Applications via a
second call) are tribal knowledge each consumer rediscovers.

This repo inverts the ratio. It is a small **orchestrator MCP server** that
exposes a fixed three-tool surface: a specialist *directory*, a
*dispatcher*, and an environment *lookup*. A specialist is a bounded agent
loop holding a curated subset of the raw tools
plus a **playbook**: the procedure, written down. "Onboard an OIDC
application" becomes one intent, not six raw calls and guesswork.

```
Claude Code (or any MCP client)
    │  sees 3 fixed tools — directory + dispatch + env lookup, never 78 schemas
    ▼
p1-orchestrator  (this repo: one local MCP server)
    │  per dispatch: gather doc context → specialist loop (playbook + subset) → report
    ▼
PingOne MCP Server  (unchanged, raw tool supply)
    +
P1 Docs MCP service  (docs.pingidentity.com/mcp — knowledge supply)
```

**One install, nothing else to attach.** The orchestrator composes both
services itself as MCP clients: the PingOne MCP Server for raw tool supply,
the PingOne Docs MCP service for knowledge supply. At dispatch it gathers
the specialist's domain docs (curated pins first, agent-fronted semantic
retrieval second — auth-free) and hands the loop a bounded, sourced excerpt.
Specialists never run doc retrieval themselves; their context arrives
distilled. If the docs service is unreachable, dispatch degrades to the
curated pins, then to playbook-only.

**Demo scope, on purpose:** this runs as a *local* MCP server for one admin.
The auth and tool execution are bounded by PingOne itself (admin permissions,
per-environment MCP enablement, secret refusal) — this layer adds narrowing,
never bypass. Multi-user hosting is deliberately out of scope here; it is a
product/deployment decision, not a pattern requirement. The graduation path
(per-user tokens against a configured login env, ingress auth, a destructive-op
deny-gate) is sketched in `p1-orchestrator-proposal.html`.

## Prerequisites

- **A PingOne environment where the PingOne MCP Server is enabled** (that
  enablement also pre-registers the `pingone-mcp-server` OAuth client the
  orchestrator authenticates through — nothing to create). An admin person
  in that environment signs in once, in the browser, during setup.
- **Node 22+** and npm.
- **Nothing else.** The Docs MCP service (docs.pingidentity.com/mcp) needs
  no install, no attach, and no auth — the orchestrator reaches it itself
  for specialist doc context, and degrades gracefully if it's unreachable.
- *(Optional)* `pingcli` — only needed for the pingcli-bridge fallback:
  specialists whose domains the P1 MCP catalog doesn't carry yet (Protect,
  MFA today) fall back to `pingcli` commands with a profile holding a
  Worker role assignment. Catalog-backed specialists (apps, users, audit,
  DaVinci) need nothing beyond the MCP server itself.

## Quick start

One variable drives setup: `P1_MCP_URL` — your PingOne MCP server URL,
copied from the same config where you'd attach the P1 server itself. The
admin env UUID inside it is the OAuth login env; the task env resolves per
dispatch (explicit `environmentId`, else the URL's admin env).

```bash
npm install

# 1. One-time browser login (pre-wired pingone-mcp-server client,
#    OIDC code + PKCE — the same auth the P1 MCP Server performs).
#    Token is cached at ~/.p1-orchestrator/tokens.json and refreshed.
P1_MCP_URL=https://mcp.pingone.com/admin/<admin-env-uuid>/mcp npm run login

# 2. Drive one specialist directly (no MCP layer) — the fast dev loop:
P1_MCP_URL=https://mcp.pingone.com/admin/<admin-env-uuid>/mcp \
npm run probe -- app_onboarding \
  "Create an OIDC web app named demo-app with scopes openid profile email,
   PKCE enforced, redirect http://localhost:3000/callback, enabled"

# 3. Attach the orchestrator to Claude Code:
npm run build
P1_MCP_URL=https://mcp.pingone.com/admin/<admin-env-uuid>/mcp \
claude mcp add p1-orchestrator \
  --env P1_MCP_URL=https://mcp.pingone.com/admin/<admin-env-uuid>/mcp \
  -- node "$(pwd)/dist/server.js"
```

That's the whole setup. Specialists act on whatever environment the
dispatch names — `environmentId` on `dispatch_specialist`, else the URL's
admin env. No environment is pinned by the layer: what's reachable is
whatever your identity's PingOne permissions cover, discoverable with the
`resolve_environment` tool. `P1_ENVIRONMENT_ID` exists only as an optional
deployment default (env vars: `P1_ACCESS_TOKEN` for CI/headless one-shots,
`P1_SPECIALIST_MODEL`, `SPECIALIST_ENGINE`).

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

- **`specialists/` in the repo** — the product's specialist set, versioned
  with the code. Everything here encodes domain knowledge worth transferring
  (tool subsets, playbooks, tribal knowledge), so all specialists live here.
- **`~/.p1-orchestrator/specialists/`** — personal overrides only. A drop-in
  overrides a same-name default; use it to experiment with a playbook edit
  before committing it, or to add a tenant-specific specialist you wouldn't
  ship. Reloaded on a 30s TTL: file appears, next dispatch finds it, no
  server restart, no client reconnect, no recompile.

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

## When does auth happen?

Not at attach, and not at discovery. `list_specialists` reads the local
registry only — no PingOne call, no token, so browsing the menu is free.
The OAuth browser dance fires at the first call that must reach PingOne
(`resolve_environment` or `dispatch_specialist`), once, and the token is
then cached and refreshed. An attached-but-unused orchestrator never
prompts; a directory listing leaks nothing (the one-liners are static
declarations with nothing tenant-specific in them).

## Visibility

Every specialist run emits three lenses: live MCP progress events (tool calls
with arg previews, as they happen), a per-run NDJSON audit log at
`~/.p1-orchestrator/runs/`, and a resumable `session_id` for post-hoc
interrogation of the specialist's own reasoning.

## License

[MIT](LICENSE) — use it, fork it, ship the pattern. Attribution appreciated,
not required beyond the copyright line.
