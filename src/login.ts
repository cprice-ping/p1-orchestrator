/**
 * login.ts — one-time browser login: complete the OAuth dance, cache the
 * token, exit. Separate from probes/servers so shell lifetimes never race
 * the human's browser session. Run once per machine; everything else just
 * reads the cache and refreshes.
 *
 * Env: P1_ENVIRONMENT_ID (admin env UUID; defaults to 2087f9ab-…)
 */

import { resolveToken } from "./auth.js";

const envId = process.env.P1_ENVIRONMENT_ID ?? "2087f9ab-c416-45c4-92f1-22bbc894407c";

console.error(`Obtaining PingOne admin token for environment ${envId}…`);
const { via } = await resolveToken(envId, "");
console.log(`OK — token cached (via: ${via}). Specialists can now launch without further logins.`);
