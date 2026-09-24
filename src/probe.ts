/**
 * probe.ts — run one specialist directly, no MCP layer. For measuring the
 * routed pattern against the flat one and for iterating on playbooks fast.
 *
 * Env: P1_MCP_URL (required), P1_ENVIRONMENT_ID (optional — defaults to
 * the admin env parsed from the URL), P1_ACCESS_TOKEN, P1_ALLOW_DESTRUCTIVE=1
 * (opt in to delete* tools, like dispatch_specialist's allowDestructive)
 * Args: <specialist-name> <intent...>
 */

import { envIdFromMcpUrl, launchSpecialist } from "./launch.js";
import { listAll } from "./registry.js";

const [name, ...rest] = process.argv.slice(2);
const intent = rest.join(" ");

if (!name || !intent) {
  const known = (await listAll()).map((s) => s.name);
  console.error(
    `Usage: npm run probe -- <specialist> "<intent>"\n` +
      `Specialists: ${known.join(", ")}`,
  );
  process.exit(1);
}

const all = await listAll();
const def = all.find((s) => s.name === name);
if (!def) {
  console.error(`Unknown specialist: ${name}`);
  process.exit(1);
}

const url = process.env.P1_MCP_URL;
const envId =
  process.env.P1_ENVIRONMENT_ID ?? envIdFromMcpUrl(url ?? "");
if ((!url && def.transport !== "authorize-cli") || !envId) {
  console.error(
    "Set P1_MCP_URL=https://mcp.pingone.com/admin/<admin-env-uuid>/mcp first.\n" +
      "P1_ENVIRONMENT_ID optionally overrides the task env (default: the URL's admin env).",
  );
  process.exit(1);
}

const t0 = Date.now();
const engine = (process.env.SPECIALIST_ENGINE ?? "claude").toLowerCase();
console.error(`  engine: ${engine}${process.env.P1_SPECIALIST_MODEL ? ` (${process.env.P1_SPECIALIST_MODEL})` : ""}`);
const out = await launchSpecialist(
  { intent, environmentId: envId, allowDestructive: process.env.P1_ALLOW_DESTRUCTIVE === "1", authorizeMode: (process.env.AUTHORIZE_MODE ?? "inspect") as never },
  def,
  {
    onEvent: (e) => {
      if (e.kind === "tool_call") {
        console.error(`  → ${e.name.replace(/^mcp__pingone__/, "")} ${e.argsPreview}`);
      } else if (e.kind === "text" && e.text.trim()) {
        console.error(`  · ${e.text.split("\n")[0].slice(0, 140)}`);
      } else if (e.kind === "init") {
        console.error(`  ⏵ specialist starting (${e.visibleMcpTools} tools in scope)`);
      } else if (e.kind === "done") {
        console.error(`  ⏹ ${e.isError ? "FAILED" : "ok"} — ${e.toolCalls} tool calls, ${(e.ms / 1000).toFixed(1)}s`);
      }
    },
  },
);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log("=== tool calls ===");
for (const c of out.toolCalls) console.log("  ", c);
console.log(`\n=== report (${secs}s, ${out.isError ? "FAILED" : "ok"}) ===`);
console.log(out.report || "(empty)");
if (out.diagnostics) console.log("\n=== diagnostics ===");
if (out.diagnostics) console.log(out.diagnostics);
console.log(`run log: ${out.logPath}`);
if (out.sessionId) console.log(`\nsession_id: ${out.sessionId}`);
