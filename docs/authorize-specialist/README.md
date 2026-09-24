# Authorize specialist: PingCLI coverage and integration draft

Date: 2026-09-24. Status: source-reviewed specialist draft, NOT INSTALLED, NOT LIVE TESTED.
PingCLI itself is installed and its local command help is verified.

The proposed pattern is viable: use p1-orchestrator's specialist registry and
PingCLI fallback. Full Authorize policy authoring needs a bridge extension, not
only a new specialist JSON file. The supplied draft deliberately exposes six
inventory reads; its policy-authoring procedure is retained as guidance for the
future bounded adapter, not a claim that those write capabilities exist today.

## Evidence and limits

- Orchestrator source pinned to `701d9014243efff0279d9a39f7f1a23960c8a847`.
- PingCLI generated **dev** command reference pinned to
  `b5b87cfff41553f975a93882d18f971efbee4428`. This is documentation generated from
  its command tree, not inspected CLI implementation or a tested release binary.
- PingCLI v1.8.0 for macOS arm64 was checksum-verified against the official
  release asset digest. The binary reports commit
  `af4a55ac97fca6b82362cfe9ecb69bfcd131864f`.
- All six inventory command/flag mappings passed local help checks using an
  isolated empty configuration. A help-only parser check confirmed that generic
  `pingone api` rejects `--environment-id`.
- No live MCP catalog, credential profile, tenant API, model dispatch, policy
  write, or deployment was exercised. These checks establish CLI syntax only.
- The definition is kept in this documentation directory, outside `specialists/`,
  so it is not automatically registered before the integration gaps are addressed.

## Operation coverage

All native commands below start with `pingcli pingone authorize`. The six draft
reads have local v1.8.0 help verification, not target-tenant validation. Resource IDs use named flags,
not bare positional IDs.

| Required capability | Documented route | Assessment |
|---|---|---|
| List/read API Services | `api-servers list`; `api-servers get --api-server-id ID` | Native; draft includes reads |
| List/read operations | `api-servers operations list --api-server-id ID`; `get --api-server-id ID --api-server-operation-id ID` | Native; draft includes reads |
| Configure API Services/operations | Corresponding `create`, `replace`, `apply` | Native command families; no writes in draft; payload compatibility still needs verification |
| List/read Decision Endpoints | `decision-endpoints list`; `get --decision-endpoint-id ID` | Native; draft includes reads |
| Configure Decision Endpoints | `decision-endpoints create/replace/apply` | Native family; full `authorizationVersion.id` payload preservation not tested; do not infer attachment from `--policy-id` |
| Application resources, roles, permissions | `application-resources`, `application-roles`, `permissions` | Native families; these are not the Authorize policy tree |
| Read/create/update policies and embedded rules | Generic management API: `authorizationPolicies` | No dedicated command found in the reviewed command tree; needs bounded adapter |
| Exact Custom-node child placement | Generic `PUT authorizationPolicies/{customNodeId}` | Fresh restrictions/version + preserve children; parent and child readback required |
| Trust Framework attributes/services | Generic `authorizationAttributes`, `authorizationServices` | No dedicated command found; separate schemas and hierarchy rules required |
| Authorization version tagging | Generic `PUT authorizationVersions/{versionId}/tag` | No dedicated command found; payload and media type must be verified |
| AAM deployment/readback | Generic `POST/GET apiServers/{apiServerId}/deployment` | No dedicated command found; deployment is a separate permitted action |
| Direct decisions/recent history | Generic endpoint evaluation/history routes | No dedicated command found; exact route, response, and tenant capability need verification |
| Gateway Sideband proof | Gateway/runtime integration, separate credentials and target | Not established by management CLI coverage; excluded from draft |

Generic API URI examples are relative to the configured management API:

```text
pingcli --profile <explicit-profile> pingone api --fail --http-method GET -O json environments/<environment-id>/authorizationPolicies/<policy-id>
```

This is a documentation example, NOT RUN. The generic command documents
`--http-method`, `--header`, `--data` (file), and `--data-raw`; it does not document
`--environment-id` or stdin `--data -`. Do not assume native `--from-file -`
semantics carry over. A future adapter should use a private temporary body file
with cleanup and no secrets in argv, after validating the body and exact route.

## What the existing pattern actually does

The Claude launcher prefers an exact live MCP tool-name match and otherwise uses
the specialist's CLI fallback. It does not establish semantic equivalence between
two same-named tools. The draft uses explicitly local aliases to avoid accidental
matching; replace them with native MCP names only after schema/behavior review.

The bridge uses `spawn` with an argument array, not shell evaluation. However, it
appends model-supplied `positional` strings as CLI arguments, allows environment
overrides in the Claude tool schema, and defaults its profile to `prod`.
Consequently a read-only tool list alone is not an enforced environment boundary.
These are source findings, not attempted exploits or observed tenant incidents.

Specific integration issues at the pinned versions:

1. Generic API commands cannot be copied into the existing fallback unchanged
   (confirmed by a local v1.8.0 help-only parser check):
   the bridge unconditionally appends `--environment-id`, and performs no route
   placeholder substitution. Generic API URIs need the environment embedded.
2. Protect/MFA examples use `--file` and bare IDs; current generated docs specify
   `--from-file` and named ID flags. Treat these as version mismatches to test,
   not proof that the coworker's installed version fails.
3. The MFA playbook suggests putting flags in `body`; bridge source sends body
   only to stdin, so it does not turn that string into argv flags.
4. The Gemini engine rejects missing catalog tools and does not execute fallback
   definitions. This draft targets the Claude path only until parity is added.
5. Generic API calls need `--fail`; otherwise an HTTP failure may not become a
   nonzero exit status. Existing bridge success is based only on exit code.
6. Bridge responses are truncated at 24,000 characters. Never use a truncated
   policy tree to construct a full replacement PUT.
7. The current destructive gate matches tool names beginning with delete/remove.
   Policy replacement can remove children, and deployment can activate changes;
   neither is protected merely by that naming check.
8. Authorize topics are absent from the current corpus Topic/DOC_MAP. The draft
   uses `topics: []`; it does not pretend a custom topic automatically retrieves
   Authorize documentation.

## Deliverables

- [authorize_policy.specialist.json](authorize_policy.specialist.json):
  registry-shaped, inventory-only draft with verified documentation mappings.
  Do not install it until the execution prerequisites below pass.
- [AUTHORING_PLAYBOOK.md](AUTHORING_PLAYBOOK.md): portable Authorize procedure,
  adapted from prior Authorize integration observations. Also embedded in the JSON so the
  specialist does not depend on filesystem tools or inherited project instructions.

The JSON is deliberately limited rather than inventing missing CLI commands or
exposing an unrestricted `pingone api` tool. It can inspect supported resource
metadata and explain the blocked authoring steps; it cannot author/deploy policies.

## Required implementation before execution

1. Completed locally: pin released PingCLI v1.8.0 and confirm its help against the
   six read mappings. Repeat for each future adapter operation and installation.
2. Require an explicit CLI profile and operator-approved environment allowlist.
   Record the CLI identity separately from the MCP administrator; no implicit
   fallback from one identity to a more privileged identity.
3. Replace arbitrary positional arguments with typed UUID inputs. The adapter
   constructs and validates flags/URIs, refuses environment/profile/config/header
   overrides, and checks the dispatch target on every native and fallback call.
4. Add explicit Authorize operations for policy/attribute read and write. Bind
   allowed HTTP method, path template, request schema, and risk class in code.
   Do not expose arbitrary URLs, HTTP methods, file paths, or raw CLI arguments.
5. Separate inspect, author, deploy, evaluate, and delete capabilities. Validate
   full replacement bodies against a fresh read; preserve unrelated children.
   Parent-model flags alone are not proof of human approval. An always-current
   Decision Endpoint may make an edit effective without a separate deployment.
6. Fail on HTTP errors, malformed/truncated JSON, missing executable, timeout,
   conflicting versions, or incomplete paging. Redact nested/encoded token fields
   before returning or logging data. Preserve bounded status/error evidence.
7. Add Authorize corpus references and implement both engine paths or reject the
   unsupported engine clearly before dispatch. No claim of Gemini CLI support.

## Acceptance sequence and next bounded action

Next: implement and mock-test the typed bridge in an isolated p1-orchestrator
checkout, with no live writes. Test argv/route construction; profile/environment
override rejection; missing binary; timeout; HTTP failure; oversized/malformed
responses; stale versions; child preservation; deployment rejection in inspect
mode; nested secret redaction; and engine capability checks.

Then, with a configured explicit profile and authorized target, run one read-only
Protect list through the actual orchestrator (a transport smoke test) and bounded
Authorize inventory reads. Distinguish a direct CLI result from a specialist
dispatch result. Policy authoring requires its own verified adapter and scoped
canary; this assessment does not authorize future live changes.

## Sources

- [Protect specialist](https://github.com/cprice-ping/p1-orchestrator/blob/701d9014243efff0279d9a39f7f1a23960c8a847/specialists/protect_policy.specialist.json)
- [MFA specialist](https://github.com/cprice-ping/p1-orchestrator/blob/701d9014243efff0279d9a39f7f1a23960c8a847/specialists/mfa_policy.specialist.json)
- [CLI bridge](https://github.com/cprice-ping/p1-orchestrator/blob/701d9014243efff0279d9a39f7f1a23960c8a847/src/pingcli-bridge.ts)
- [Claude launcher](https://github.com/cprice-ping/p1-orchestrator/blob/701d9014243efff0279d9a39f7f1a23960c8a847/src/launch.ts)
- [Gemini launcher](https://github.com/cprice-ping/p1-orchestrator/blob/701d9014243efff0279d9a39f7f1a23960c8a847/src/engines/gemini.ts)
- [Generated Authorize CLI reference](https://github.com/pingidentity/pingcli/blob/b5b87cfff41553f975a93882d18f971efbee4428/.agents/skills/pingcli-usage/references/cmd-pingcli-pingone-authorize.md)
- [Generic API CLI reference](https://github.com/pingidentity/pingcli/blob/b5b87cfff41553f975a93882d18f971efbee4428/.agents/skills/pingcli-usage/references/cmd-pingcli-pingone-api.md)
- [PingOne Authorize policy documentation](https://docs.pingidentity.com/pingone/authorization_using_pingone_authorize/p1az_policies.html)

Local validation: installed CLI version/help checks, JSON parse/registry field checks, exact embedded playbook match,
six fallback mappings checked against the pinned command-reference flags, local
Markdown links, and Git whitespace checks. No application test suite was needed
for this documentation/draft-only change. No live capability or safety claim is
established by those checks.
