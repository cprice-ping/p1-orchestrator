/**
 * Specialist registry — the transferable artifact.
 *
 * Every specialist is a JSON file, nothing else:
 *   - `specialists/` in the repo: the shipped defaults, versioned with the code.
 *   - `~/.p1-orchestrator/specialists/`: local drop-ins; adding a specialist is
 *     writing one file, never a redeploy. A drop-in overrides a same-name default.
 *
 * A specialist file = { name, description, tools, playbook }:
 *   - `description` is ALL the orchestrator sees when routing (keep it crisp).
 *   - `tools` is the subset of raw PingOne MCP tool names (camelCase, bare).
 *   - `playbook` becomes the specialist's entire system prompt: procedure,
 *     not vibes. It encodes how the tools chain — the tribal knowledge the
 *     raw server leaves to the caller.
 */

export interface SpecialistDef {
  /** MCP tool name exposed by the orchestrator server, snake_case. */
  name: string;
  /** One-liner the orchestrator routes on. This is the whole routing surface. */
  description: string;
  /** Required input args beyond { intent }. environmentId handled separately. */
  requires: readonly string[];
  /** Raw PingOne MCP tool names this specialist may call (bare, camelCase). */
  tools: readonly string[];
  /** Optional model override (cheap tier for simple specialists, etc.).
   *  Falls back to P1_SPECIALIST_MODEL, then ANTHROPIC_MODEL (inherit). */
  model?: string;
  /** Corpus topics this specialist can act on — the orchestrator gathers
   *  situational context from the doc map for matching intents. */
  topics?: readonly string[];
  /** Fallback transport for tools the live catalog lacks: MCP tool name →
   *  pingcli subcommand. The launcher bridges these as CLI-backed tools. */
  fallback?: Readonly<Record<string, unknown>>;
  /** The specialist's entire system prompt. */
  playbook: string;
}

export const SHARED_RULES = `
Operating constraints (from the PingOne MCP server — apply always):
- No tool accepts secret values, and secrets in responses are masked or redacted.
  Never echo a secret back or invent an argument to carry one.
- environmentId is always supplied to you in the task. Use it as-is; do not
  ask for it and do not call listEnvironments unless the task explicitly
  requires discovering environments.
- Pass user-supplied content (flow JSON, exports) verbatim — never modify,
  summarise, or reconstruct it.
- Prefer the narrowest read call first, then write. Confirm before any
  delete or disable; if a destructive op is not clearly required, report
  instead of acting.
- If the task needs a tool outside your set, STOP and report exactly what
  is missing rather than improvising.
- Finish with a compact summary: what you did, IDs created/changed, anything
  the caller must verify by hand.
`.trim();

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Shipped defaults: <repo>/specialists/*.specialist.json, versioned in git. */
const BUNDLED_DIR = fileURLToPath(new URL("../specialists/", import.meta.url));
/** Local drop-ins: outside the repo, no redeploy. Overrides same-name default. */
const EXTRA_DIR = join(homedir(), ".p1-orchestrator", "specialists");
const TTL_MS = 30_000;

interface DirCache {
  at: number;
  defs: SpecialistDef[];
}

async function readDir(dir: string, label: string): Promise<SpecialistDef[]> {
  const defs: SpecialistDef[] = [];
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".specialist.json"));
    for (const f of files) {
      try {
        const raw = JSON.parse(await readFile(join(dir, f), "utf8")) as SpecialistDef;
        if (!raw.name || !raw.description || !raw.tools?.length || !raw.playbook) {
          console.error(`[registry] ${label}/${f}: missing name/description/tools/playbook — skipped`);
          continue;
        }
        defs.push(raw);
      } catch (err) {
        console.error(`[registry] failed to load ${label}/${f}:`, err instanceof Error ? err.message : err);
      }
    }
  } catch {
    /* dir absent */
  }
  return defs;
}

/** Cache both layers together: a 30s TTL on the merged list. */
let cache: { at: number; defs: SpecialistDef[] } | null = null;

async function loadAll(): Promise<SpecialistDef[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.defs;
  const bundled = await readDir(BUNDLED_DIR, "specialists");
  const extras = await readDir(EXTRA_DIR, "drop-ins");
  const extraNames = new Set(extras.map((s) => s.name));
  const defs = [...bundled.filter((s) => !extraNames.has(s.name)), ...extras];
  cache = { at: Date.now(), defs };
  return defs;
}

/** All specialists: shipped defaults + local drop-ins (drop-in wins on name clash). */
export async function listAll(): Promise<SpecialistDef[]> {
  return loadAll();
}

export const MCP_SERVER_NAME = "pingone";
