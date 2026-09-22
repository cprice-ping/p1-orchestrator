/**
 * p1-probe.ts — minimal connectivity check against the P1 MCP server:
 * initialize → tools/list → print the catalog. No LLM involved.
 *
 * Env: P1_MCP_URL, P1_ACCESS_TOKEN
 */

import { fetchToolCatalog, DEFAULT_P1_MCP_URL } from "./launch.js";
import { resolveToken } from "./auth.js";

const url = process.env.P1_MCP_URL ?? DEFAULT_P1_MCP_URL;

try {
  // Token via env → cache → refresh → one-time browser dance.
  const { token, via } = await resolveToken(
    process.env.P1_ENVIRONMENT_ID ?? "2087f9ab-c416-45c4-92f1-22bbc894407c",
    url,
  );
  console.error(`(token via: ${via})`);
  const tools = await fetchToolCatalog(url, token);
  console.log(`P1 MCP server reachable. ${tools.length} tools:`);
  for (const t of tools.sort()) console.log(`  - ${t}`);
} catch (err) {
  console.error(
    "Probe failed:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
}
