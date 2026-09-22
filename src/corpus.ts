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

// ---------------------------------------------------------------------------
// Dynamic tier: live llms.txt index matching + pin freshness checking.
// ---------------------------------------------------------------------------

const INDEX_URL = "https://developer.pingidentity.com/pingone-api/llms.txt";
const INDEX_TTL_MS = 60 * 60 * 1000; // 1h
let indexCache: { at: number; entries: IndexEntry[] } | null = null;

interface IndexEntry {
  title: string;
  url: string;
  description: string;
}

async function loadIndex(): Promise<IndexEntry[]> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) {
    return indexCache.entries;
  }
  const res = await fetch(INDEX_URL, { headers: { Accept: "text/plain" } });
  if (!res.ok) throw new Error(`llms.txt fetch failed: ${res.status}`);
  const text = await res.text();
  const entries: IndexEntry[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^- \[([^\]]+)\]\((https:\S+\.md)\)(?::\s*(.+))?$/);
    if (m) entries.push({ title: m[1], url: m[2], description: m[3] ?? "" });
  }
  indexCache = { at: Date.now(), entries };
  return entries;
}

/** Keyword score of an index entry against the intent. */
function scoreEntry(e: IndexEntry, words: string[]): number {
  const hay = `${e.title} ${e.description}`.toLowerCase();
  let score = 0;
  for (const w of words) {
    const hits = hay.split(w).length - 1;
    if (hits > 0) score += hits * Math.min(w.length / 4, 3);
  }
  return score;
}

/**
 * Dynamic tier: top-N index entries matching the intent, excluding pins.
 * Best-effort — the index is a catalog of titles, so keyword scoring over
 * title+description is the whole trick. Misses are a signal the curated
 * map needs a pin, not an error.
 */
export async function indexMatch(
  intent: string,
  topN = 2,
  excludeUrls: string[] = [],
): Promise<DocDoc[]> {
  const words = intent.toLowerCase().split(/[^a-z_:-]+/).filter((w) => w.length > 3);
  const entries = await loadIndex();
  const excluded = new Set(excludeUrls);
  return entries
    .filter((e) => !excluded.has(e.url))
    .map((e) => ({ e, s: scoreEntry(e, words) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, topN)
    .map(({ e }) => ({
      title: e.title,
      url: e.url,
      decides: "auto-matched from live docset index (llms.txt)",
    }));
}

// ---------------------------------------------------------------------------
// Pin freshness: do curated pins still resolve, and still appear in the
// docset index? Run at startup / on a schedule / as a one-shot CLI.
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
  const index = await loadIndex().catch(() => [] as IndexEntry[]);
  const knownUrls = new Set(index.map((e) => e.url));

  const results: PinHealth[] = [];
  for (const { topic, doc } of pins) {
    try {
      const res = await fetch(doc.url, { method: "HEAD", headers: { Accept: "text/markdown" } });
      if (res.status === 404) {
        results.push({ url: doc.url, topic, title: doc.title, status: "dead", detail: "404 — pin needs re-curation" });
      } else if (!res.ok) {
        results.push({ url: doc.url, topic, title: doc.title, status: "drift", detail: `HTTP ${res.status}` });
      } else {
        results.push({
          url: doc.url,
          topic,
          title: doc.title,
          status: knownUrls.size === 0 || knownUrls.has(doc.url) ? "ok" : "drift",
          detail: knownUrls.size > 0 && !knownUrls.has(doc.url) ? "not in current llms.txt — moved or retitled?" : undefined,
        });
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

  // Dynamic tier: fill to a bound from the live llms.txt index.
  try {
    const extra = await indexMatch(low, 2, docs.map((d) => d.url));
    docs = [...docs, ...extra].slice(0, 5);
  } catch (err) {
    console.error("[corpus] index match failed (pins only):", err instanceof Error ? err.message : err);
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
