/**
 * probe.ts — run one specialist directly, no MCP layer. For measuring the
 * routed pattern against the flat one and for iterating on playbooks fast.
 *
 * Env: P1_MCP_URL, P1_ACCESS_TOKEN, P1_ENVIRONMENT_ID
 * Args: <specialist-name> <intent...>
 */

import { launchSpecialist, DEFAULT_P1_MCP_URL } from "./launch.js";
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

const url = process.env.P1_MCP_URL ?? DEFAULT_P1_MCP_URL;
const envId = process.env.P1_ENVIRONMENT_ID ?? "3f720e3e-ceb4-43a7-bb45-45b05eb26280"; // Agentic AI sandbox default
if (!envId) {
  console.error("Set P1_ENVIRONMENT_ID (or P1_MCP_URL) first.");
  process.exit(1);
}

const t0 = Date.now();
const engine = (process.env.SPECIALIST_ENGINE ?? "claude").toLowerCase();
console.error(`  engine: ${engine}${process.env.P1_SPECIALIST_MODEL ? ` (${process.env.P1_SPECIALIST_MODEL})` : ""}`);
const out = await launchSpecialist(
  { intent, environmentId: envId },
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
