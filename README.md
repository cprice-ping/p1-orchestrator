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

# 1. Drive one specialist directly (no MCP layer) — the fast dev loop.
#    First run opens the browser once (OIDC code + PKCE, the same auth
#    the P1 MCP Server performs): tokens live in the process, nowhere else.
P1_MCP_URL=https://mcp.pingone.com/admin/<admin-env-uuid>/mcp \
npm run probe -- app_onboarding \
  "Create an OIDC web app named demo-app with scopes openid profile email,
   PKCE enforced, redirect http://localhost:3000/callback, enabled"

# 2. Attach the orchestrator to Claude Code:
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
| `src/auth.ts` | P1 OAuth: pre-wired client, browser dance per session, tokens in process memory only. |
| `src/server.ts` | The orchestrator MCP server (progress notifications, run-log paths). |
| `src/probe.ts` · `src/p1-probe.ts` | Direct specialist runner (the fast dev loop) · raw connectivity probe. |
| `p1-orchestrator-proposal.html` | The product-team writeup: problem, pattern, live-tenant evidence, asks. |

## When does auth happen?

We authn at the point we need to, not before. Not at attach, and not at
discovery: `list_specialists` reads the local
registry only — no PingOne call, no token, so browsing the menu is free.
The OAuth browser dance fires at the first call that must reach PingOne
(`resolve_environment` or `dispatch_specialist`), once. **Tokens live in
the orchestrator server's memory — no token file exists.** That is the
boundary made structural: the orchestrator is the agent's only P1 surface,
the server holds the tokens, and no model (or other local process) can
read one. The cost is one browser dance per session (tokens die with the
server) — so nothing sits on disk for another process to read. The
consent boundary is the SSO session: the first AuthN of a session is
interactive (the human signs in); later requests mint silently while
that session lives. Another agent's direct P1 access rides the session
the human established — per-action consent is what the specialist
gates provide, on the gated path. Practical note: make the *first*
dispatch of a session something small — the browser dance happens inside
it, and an MCP client's 60s call timeout will expire if the human doesn't
finish the sign-in in that window. A directory listing leaks nothing
(the one-liners are static declarations with nothing tenant-specific in
them).

## Guardrails

A specialist can call only its declared tool subset: no built-in tools
(no shell, no file access), and every tool call goes through one
fail-closed permission gate. Delete operations are refused unless the
dispatch sets `allowDestructive: true`. Without it, the specialist reports
what it would delete, so the caller can re-dispatch deliberately. The
Gemini engine enforces the same gate. For `npm run probe`, opt in with
`P1_ALLOW_DESTRUCTIVE=1`. A refused call is also reported by the
orchestrator itself at the end of the dispatch result, along with the next
step, so the operator sees it even if the specialist's report doesn't
mention it.

The PingOne connection never leaves the orchestrator process. Specialists
reach PingOne through an in-process proxy, so the bearer token is never
handed to the specialist runtime's child process. That means it never
appears in its command line or environment.

The operator's guardrails come from the server. The orchestrator's MCP
`initialize` reply carries `instructions` that MCP clients (Claude Code
among them) add to the operating agent's system prompt: make PingOne changes
only through `dispatch_specialist`, never by direct API calls, `pingcli`, or
a found token; relay refusals instead of finishing the action another way;
confirm deletes with the user before re-dispatching with `allowDestructive`.
There is nothing to install or configure. These instructions guide a
cooperative operator; they are not enforcement. What stops a determined
agent is PingOne itself (roles, sign-on policy), and on a local machine
the orchestrator can't take away a shell's other routes (the browser's
PingOne sign-in session, a `pingcli` profile).

## Visibility

Every specialist run emits three lenses: live MCP progress events (tool calls
with arg previews, as they happen), a per-run NDJSON audit log at
`~/.p1-orchestrator/runs/`, and a resumable `session_id` for post-hoc
interrogation of the specialist's own reasoning.

## License

[MIT](LICENSE) — use it, fork it, ship the pattern. Attribution appreciated,
not required beyond the copyright line.
