/**
 * login.ts — one-time browser login: complete the OAuth dance, cache the
 * token, exit. Separate from probes/servers so shell lifetimes never race
 * the human's browser session. Run once per machine; everything else just
 * reads the cache and refreshes.
 *
 * Env: P1_MCP_URL (preferred — the admin env UUID is parsed from its
 * /admin/<uuid>/mcp path) or P1_ENVIRONMENT_ID as a fallback.
 */

import { envIdFromMcpUrl } from "./launch.js";
import { resolveToken } from "./auth.js";

const envId =
  envIdFromMcpUrl(process.env.P1_MCP_URL ?? "") ?? process.env.P1_ENVIRONMENT_ID;

if (!envId) {
  console.error(
    "Set P1_MCP_URL to your PingOne MCP server URL first\n" +
      "(https://mcp.pingone.com/admin/<admin-env-uuid>/mcp — the UUID inside\n" +
      "it is the OAuth login env). P1_ENVIRONMENT_ID works as a fallback.",
  );
  process.exit(1);
}

console.error(`Obtaining PingOne admin token for environment ${envId}…`);
const { via } = await resolveToken(envId, "");
console.log(`OK — token cached (via: ${via}). Specialists can now launch without further logins.`);
