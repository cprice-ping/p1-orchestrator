/**
 * p1-probe.ts — minimal connectivity check against the P1 MCP server:
 * initialize → tools/list → print the catalog. No LLM involved.
 *
 * Env: P1_MCP_URL, P1_ACCESS_TOKEN
 */

import { fetchToolCatalog } from "./launch.js";
import { resolveToken } from "./auth.js";

const url = process.env.P1_MCP_URL;

if (!url) {
  console.error(
    "Set P1_MCP_URL=https://mcp.pingone.com/admin/<admin-env-uuid>/mcp first\n" +
      "(the URL from your PingOne MCP server config).",
  );
  process.exit(1);
}

try {
  // Token via env → cache → refresh → one-time browser dance.
  const { token, via } = await resolveToken(
    process.env.P1_ENVIRONMENT_ID ?? url.split("/admin/")[1]?.split("/")[0] ?? "",
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
