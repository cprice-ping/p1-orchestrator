/**
 * corpus.ts — the curated doc map: topic → the few authoritative pages.
 *
 * Ping ships agent-aware docs (llms.txt indexes, .md alternates) — but the
 * 1,730-entry docset index is too coarse for routing, and the tool catalog
 * doesn't bind tools to docs. This file is the missing binding, curated to
 * the topics our specialists actually touch. Dozens of entries, not
 * thousands; versioned like the registry; swappable for a P1-shipped map
 * (the proposal asks them to publish tool→doc bindings natively).
 *
 * Every entry was fetched and verified at build time (2026-09-22).
 */

export interface DocRef {
  /** Human title from the docset index. */
  title: string;
  /** The .md alternate — token-efficient, no HTML chrome. */
  url: string;
  /** What this page decides — one line, for the distiller's prompt. */
  decides: string;
}

/** Topic keys: what an intent might be "about", matched by the router. */
export type Topic =
  | "token-exchange"
  | "app-types"
  | "app-creation"
  | "resource-grants"
  | "resources-scopes"
  | "worker-apps"
  | "mfa-policies"
  | "fido2-passkeys"
  | "passwordless"
  | "protect-policy-sets"
  | "protect-predictors";

export const DOC_MAP: Partial<Record<Topic, DocDoc[]>> = {
  "token-exchange": [
    {
      title: "Token exchange grant type",
      url: "https://developer.pingidentity.com/pingone-api/foundations/authentication-concepts/authorization-flow-by-grant-type/token-exchange-grant-type.md",
      decides:
        "token-exchange is an application grantTypes value; requires a confidential tokenEndpointAuthMethod; the request is subject_token + scope, and the returned token's permissions come from the application's configured scopes",
    },
    {
      title: "Authorization and authentication by application type",
      url: "https://developer.pingidentity.com/pingone-api/foundations/management-apis-overview/application-management-apis.md",
      decides:
        "application type taxonomy and per-type tokenEndpointAuthMethod rules; Worker and Non-interactive are excluded from NONE auth",
    },
    {
      title: "Worker applications",
      url: "https://developer.pingidentity.com/pingone-api/foundations/authentication-concepts/authorization-and-authentication-by-application-type/worker-applications.md",
      decides:
        "Worker apps are ADMINISTRATOR clients for platform APIs, access governed by role assignments, not resource grants — the contrast class for token-exchange apps",
    },
  ],
  "app-creation": [
    {
      title: "Application Operations (data model)",
      url: "https://developer.pingidentity.com/pingone-api/platform/applications/applications-1.md",
      decides:
        "the application data model: type + protocol are required and immutable; default tokenEndpointAuthMethod per type",
    },
  ],
  "resource-grants": [
    {
      title: "Application Resource Grants",
      url: "https://developer.pingidentity.com/pingone-api/platform/applications/application-resource-grants.md",
      decides:
        "resource access grants let an application request OAuth scopes for protected resources; one grant per resource per app",
    },
  ],
  "worker-apps": [
    {
      title: "Worker applications",
      url: "https://developer.pingidentity.com/pingone-api/foundations/authentication-concepts/authorization-and-authentication-by-application-type/worker-applications.md",
      decides:
        "worker = administrator client for platform APIs, permission via role assignments",
    },
  ],
  "mfa-policies": [
    {
      title: "MFA Settings",
      url: "https://developer.pingidentity.com/pingone-api/mfa/mfa-settings.md",
      decides:
        "environment-wide MFA settings: max paired devices, account lockout, pairing key format — context for any device-policy work",
    },
    {
      title: "Create Sign-On Policy Action (MFA)",
      url: "https://developer.pingidentity.com/pingone-api/platform/sign-on-policies/sign-on-policy-actions/create-sign-on-policy-action-mfa.md",
      decides:
        "the MFA sign-on policy action: which device types the action permits and how MFA is required during sign-on",
    },
    {
      title: "Application Sign-On Policy Assignments",
      url: "https://developer.pingidentity.com/pingone-api/platform/applications/application-sign-on-policy-assignments.md",
      decides:
        "sign-on policies attach to applications via assignments with priority — the placement step for any new policy",
    },
  ],
  "fido2-passkeys": [
    {
      title: "FIDO Policies",
      url: "https://developer.pingidentity.com/pingone-api/mfa/fido-policies.md",
      decides:
        "FIDO policies fine-tune FIDO2 authentication: allowed authenticators, attestation requirements, custom device metadata",
    },
    {
      title: "Create FIDO Policy - FIDO-certified and enterprise",
      url: "https://developer.pingidentity.com/pingone-api/mfa/fido-policies/create_fido_policy_certified_w_enterprise_attestation.md",
      decides:
        "enterprise attestation verifies the authenticator was organization-provided — the managed-passkey pattern",
    },
  ],
  passwordless: [
    {
      title: "Login with Passwordless Authentication (workflow)",
      url: "https://developer.pingidentity.com/pingone-api/workflow-library/pingone-mfa/login-with-passwordless-authentication.md",
      decides:
        "passwordless = sign-on policy with username + MFA action instead of a password; worked end-to-end example",
    },
  ],
  "protect-policy-sets": [
    {
      title: "Create Risk Policy Set - Targeted Policy with Mitigations",
      url: "https://developer.pingidentity.com/pingone-api/protect/risk-policies/create_risk_policy_set_targeted_w_mitigations.md",
      decides:
        "preferred Protect method: targeted policies with mitigations specifying recommended actions",
    },
    {
      title: "Create Risk Policy Set (aggregated scores)",
      url: "https://developer.pingidentity.com/pingone-api/protect/risk-policies/create_risk_policy_set_scores.md",
      decides:
        "legacy method: risk predictors combined via aggregated scores producing risk levels",
    },
  ],
  "protect-predictors": [
    {
      title: "Risk Predictors (workflow index)",
      url: "https://developer.pingidentity.com/pingone-api/protect/risk-predictors/create_risk_predictor_composite.md",
      decides:
        "composite predictor pattern: conditions across other predictors assigning risk levels",
    },
  ],
};

export interface DocDoc {
  title: string;
  url: string;
  decides: string;
}

/** Keywords the orchestrator matches against the intent (lowercased). */
export const TOPIC_KEYWORDS: Partial<Record<Topic, string[]>> = {
  "token-exchange": ["token exchange", "token_exchange", "token-exchange", "subject token", "urn:ietf:params:oauth:grant-type:token-exchange"],
  "app-creation": ["create", "app", "application", "oidc", "saml"],
  "resource-grants": ["grant", "scope"],
  "worker-apps": ["worker", "client_credentials", "platform api", "admin api"],
  "mfa-policies": ["mfa", "multi-factor", "multifactor", "device policy", "2fa", "otp"],
  "fido2-passkeys": ["fido", "fido2", "passkey", "webauthn", "passkeys", "yubikey", "security key", "biometric"],
  passwordless: ["passwordless", "no password", "without password"],
  "protect-policy-sets": ["risk policy", "policy set", "mitigations", "targeted policy"],
  "protect-predictors": ["predictor", "risk level", "velocity", "bot detection", "anonymous network"],
};

export interface CorpusDoc {
  title: string;
  url: string;
  /** The distilled decision-relevant excerpt. */
  excerpt: string;
}

/** Hard cap on one doc's excerpt entering a specialist prompt. */
const MAX_EXCERPT_CHARS = 1600;

// ---------------------------------------------------------------------------
// Tier 2: semantic doc retrieval via the P1 Docs MCP service
// (https://docs.pingidentity.com/mcp — agent-fronted, interprets intent).
// Replaces the former llms.txt scrape: no URLs held locally, no index TTL,
// new pages discoverable the moment they publish. Auth-free; the specialist
// never calls this directly — the orchestrator assembles context at dispatch.
// ---------------------------------------------------------------------------

const DOCS_MCP_URL =
  process.env.P1_DOCS_MCP_URL ?? "https://docs.pingidentity.com/mcp";
const DOCS_DOCSET_FILTER = ["pingone"];

interface DocsSearchResult {
  title: string;
  url: string;
  excerpt: string;
}

/** Minimal MCP client for the docs server (no auth, stateful HTTP). */
async function docsMcpSearch(
  query: string,
  topK: number,
): Promise<DocsSearchResult[]> {
  const { McpToolClient } = await import("./engines/mcp-client.js");
  const client = new McpToolClient(DOCS_MCP_URL, "");
  try {
    const result = (await client.callTool("docsets_search", {
      query,
      docs: DOCS_DOCSET_FILTER,
      search_mode: "hybrid",
      top_k: topK,
    })) as { content: { type: string; text?: string }[] };
    const text = result.content.map((c) => c.text ?? "").join("\n");
    // The tool returns a JSON array of chunks with embedded sources.
    let parsed: { text?: string }[] = [];
    try {
      const parsed = JSON.parse(text.trim());
      if (Array.isArray(parsed)) parsed as { text?: string }[];
      const arr = parsed as { text?: string }[];
      if (Array.isArray(arr)) return arr.map(extractSource);
    } catch {
      /* fall through: chunked SSE-ish text */
    }
    // Fallback: parse any JSON array embedded in the text.
    const m = text.match(/\[\s*{[\s\S]*}\s*\]/);
    if (m) {
      try {
        const arr = JSON.parse(m[0]) as { text?: string }[];
        return arr.map(extractSource);
      } catch {
        /* fall through */
      }
    }
    return [extractSource({ text })];
  } finally {
    await client.close().catch(() => {});
  }
}

/** Pull title + source URL out of one docsets_search chunk. */
function extractSource(chunk: { text?: string }): DocsSearchResult {
  const t = chunk.text ?? "";
  // Sources appear as trailing https://... lines in each chunk.
  const urls = [...t.matchAll(/https:\/\/[^\s">]+?\.html/g)].map((m) => m[0]);
  const url = urls.at(-1) ?? "";
  const titleMatch = t.match(/^(.{5,120})/);
  return {
    title: (titleMatch?.[1] ?? "docs chunk").trim(),
    url,
    excerpt: t.slice(0, MAX_EXCERPT_CHARS),
  };
}

/**
 * Fetch one doc and extract the decision-relevant section.
 * Cheap heuristic distillation: the .md alternates are already
 * chrome-free, so we take metadata + the sections matching the
 * decision terms; callers cache the result.
 */
export async function fetchAndDistill(doc: DocDoc, focus: string): Promise<CorpusDoc> {
  const res = await fetch(doc.url, { headers: { Accept: "text/markdown" } });
  if (!res.ok) {
    throw new Error(`corpus fetch failed (${res.status}): ${doc.url}`);
  }
  const md = await res.text();

  // Split into sections; score each against the focus keywords.
  const focusWords = focus
    .toLowerCase()
    .split(/[^a-z_:]+/)
    .filter((w) => w.length > 3);
  const sections = md.split(/\n(?=#{1,3} )/);
  const scored = sections
    .map((s) => {
      const low = s.toLowerCase();
      let score = 0;
      for (const w of focusWords) {
        const hits = low.split(w).length - 1;
        score += hits * Math.min(w.length / 4, 3);
      }
      return { s, score };
    })
    .sort((a, b) => b.score - a.score);

  // Keep top sections until the cap.
  let excerpt = "";
  const picked: string[] = [];
  for (const { s } of scored) {
    if (picked.length >= 2) break;
    if (s.length > MAX_EXCERPT_CHARS) {
      picked.push(s.slice(0, MAX_EXCERPT_CHARS) + "\n…[truncated]");
    } else {
      picked.push(s);
    }
  }
  excerpt = picked.join("\n\n").slice(0, MAX_EXCERPT_CHARS * 2);

  return { title: doc.title, url: doc.url, excerpt: excerpt || md.slice(0, MAX_EXCERPT_CHARS) };
}

/**
 * Select + distill the corpus slice for an intent. Returns [] when no
 * topic matches — the specialist then runs on playbook alone (today's
 * behavior, unchanged).
 */
export async function gatherContext(
  intent: string,
  specialistTopics: Topic[],
): Promise<CorpusDoc[]> {
  const low = intent.toLowerCase();
  const topics = new Set<Topic>(specialistTopics);
  for (const [topic, kws] of Object.entries(TOPIC_KEYWORDS) as [Topic, string[]][]) {
    if (kws.some((k) => low.includes(k))) topics.add(topic);
  }
  let docs = [...topics]
    .flatMap((t) => DOC_MAP[t] ?? [])
    // dedupe by url
    .filter((d, i, a) => a.findIndex((x) => x.url === d.url) === i);

  // Verify pins resolve; drop dead ones (freshness feedback at call time).
  const healthy: DocDoc[] = [];
  for (const d of docs) {
    try {
      const probe = await fetch(d.url, { method: "HEAD", headers: { Accept: "text/markdown" } });
      if (probe.ok) healthy.push(d);
      else console.error(`[corpus] pin dead (HTTP ${probe.status}), dropped: ${d.title}`);
    } catch {
      console.error(`[corpus] pin unreachable, dropped: ${d.title}`);
    }
  }
  docs = healthy;

  // Dynamic tier: semantic retrieval from the P1 Docs MCP service.
  try {
    const searchQuery = `${intent} ${[...topics].join(" ")}`;
    const hits = await docsMcpSearch(searchQuery, 3);
    const pinnedUrls = new Set(docs.map((d) => d.url));
    const extras: DocDoc[] = hits
      .filter((h) => h.url && !pinnedUrls.has(h.url))
      .slice(0, 2)
      .map((h) => ({
        title: h.title,
        url: h.url,
        decides: "retrieved from P1 Docs MCP (docs.pingidentity.com/mcp)",
      }));
    docs = [...docs, ...extras].slice(0, 5);
  } catch (err) {
    console.error("[corpus] docs-mcp search failed (pins only):", err instanceof Error ? err.message : err);
  }
  if (docs.length === 0) return [];

  const results = await Promise.all(
    docs.map((d) =>
      fetchAndDistill(d, intent).catch((err) => {
        console.error(`[corpus] ${d.title} fetch failed:`, err instanceof Error ? err.message : err);
        return null;
      }),
    ),
  );
  return results.filter((r): r is CorpusDoc => r !== null);
}

// ---------------------------------------------------------------------------
// Pin freshness: HEAD-probe each curated pin to confirm it still resolves.
// (Content freshness is the docs service's job now; this validates only
// that our hand-curated overrides still point at real pages.)
// ---------------------------------------------------------------------------

export interface PinHealth {
  url: string;
  topic: string;
  title: string;
  status: "ok" | "drift" | "dead";
  detail?: string;
}

export interface PinReport {
  checkedAt: string;
  total: number;
  dead: number;
  drift: number;
  pins: PinHealth[];
}

export async function checkPinFreshness(): Promise<PinReport> {
  const pins: { topic: string; doc: DocDoc }[] = [];
  for (const [topic, docs] of Object.entries(DOC_MAP) as [Topic, DocDoc[]][]) {
    for (const doc of docs) pins.push({ topic, doc });
  }

  const results: PinHealth[] = [];
  for (const { topic, doc } of pins) {
    try {
      const res = await fetch(doc.url, { method: "HEAD", headers: { Accept: "text/markdown" } });
      if (res.status === 404) {
        results.push({ url: doc.url, topic, title: doc.title, status: "dead", detail: "404 — pin needs re-curation" });
      } else if (!res.ok) {
        results.push({ url: doc.url, topic, title: doc.title, status: "drift", detail: `HTTP ${res.status}` });
      } else {
        results.push({ url: doc.url, topic, title: doc.title, status: "ok" });
      }
    } catch (err) {
      results.push({ url: doc.url, topic, title: doc.title, status: "drift", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    total: results.length,
    dead: results.filter((r) => r.status === "dead").length,
    drift: results.filter((r) => r.status === "drift").length,
    pins: results,
  };
}
