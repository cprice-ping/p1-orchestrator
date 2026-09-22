/**
 * login.ts — one-time browser login: complete the OAuth dance, cache the
 * token, exit. Separate from probes/servers so shell lifetimes never race
 * the human's browser session. Run once per machine; everything else just
 * reads the cache and refreshes.
 *
 * Env: P1_ENVIRONMENT_ID — REQUIRED, your PingOne admin environment UUID
 * (the env whose MCP server URL you attach the orchestrator through).
 */

import { resolveToken } from "./auth.js";

const envId = process.env.P1_ENVIRONMENT_ID;

if (!envId) {
  console.error(
    "Set P1_ENVIRONMENT_ID to your PingOne admin environment UUID first.\n" +
      "It is the <admin-env-uuid> in your PingOne MCP server URL:\n" +
      "  https://mcp.pingone.com/admin/<admin-env-uuid>/mcp",
  );
  process.exit(1);
}

console.error(`Obtaining PingOne admin token for environment ${envId}…`);
const { via } = await resolveToken(envId, "");
console.log(`OK — token cached (via: ${via}). Specialists can now launch without further logins.`);
