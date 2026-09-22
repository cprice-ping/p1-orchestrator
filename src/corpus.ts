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
  | "worker-apps";

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
};

export interface CorpusDoc {
  title: string;
  url: string;
  /** The distilled decision-relevant excerpt. */
  excerpt: string;
}

/** Hard cap on one doc's excerpt entering a specialist prompt. */
const MAX_EXCERPT_CHARS = 1600;

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
  const docs = [...topics]
    .flatMap((t) => DOC_MAP[t] ?? [])
    // dedupe by url
    .filter((d, i, a) => a.findIndex((x) => x.url === d.url) === i);
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
