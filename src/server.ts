/**
 * server.ts — the Orchestrator MCP server ("Shape B").
 *
 * Exposes one tool per specialist plus a discovery tool. Every tool call:
 *   1. validates args (typed boundary),
 *   2. launches a specialist agent loop (fresh or resumed),
 *   3. returns the specialist's compact report.
 *
 * The orchestrator model never sees raw P1 tools; it sees ~4 one-liners.
 * Auth: P1 access token from P1_ACCESS_TOKEN env (see README).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { launchSpecialist, fetchToolCatalog } from "./launch.js";
import type { SpecialistEvent } from "./launch.js";
import { SPECIALISTS, getSpecialist } from "./registry.js";
import { resolveToken } from "./auth.js";
import { envIdFromMcpUrl } from "./launch.js";

const server = new Server(
  { name: "p1-orchestrator", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// One-line schemas; Zod→JSON schema handled by the SDK below.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      ...SPECIALISTS.map((s) => ({
        name: s.name,
        description: s.description,
        inputSchema: {
          type: "object" as const,
          properties: {
            intent: {
              type: "string",
              description:
                "What to do, in one or two sentences. Include app/user/flow specifics and any URIs, names, or scopes.",
            },
            sessionId: {
              type: "string",
              description:
                "Optional: a session_id returned by a previous call to this same tool, to continue that conversation instead of starting fresh.",
            },
          },
          required: ["intent"],
        },
      })),
      {
        name: "list_specialists",
        description:
          "List available PingOne specialists with their exact scopes of competence.",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "list_specialists") {
    return {
      content: [
        {
          type: "text",
          text: SPECIALISTS.map(
            (s) => `- ${s.name}: ${s.description}`,
          ).join("\n"),
        },
      ],
    };
  }

  const def = getSpecialist(name);
  if (!def) {
    return {
      content: [{ type: "text", text: `Unknown specialist: ${name}` }],
      isError: true,
    };
  }

  const intent = (args?.intent as string | undefined)?.trim();
  if (!intent) {
    return {
      content: [{ type: "text", text: "Missing required arg: intent" }],
      isError: true,
    };
  }

  const accessToken = process.env.P1_ACCESS_TOKEN;
  // Task target env: explicit config first (the sandbox specialists act on),
  // else parsed from the MCP URL (the admin/auth home env).
  const envId =
    process.env.P1_ENVIRONMENT_ID ??
    envIdFromMcpUrl(
      process.env.P1_MCP_URL ?? "https://mcp.pingone.com/admin/2087f9ab-c416-45c4-92f1-22bbc894407c/mcp",
    );
  if (!envId) {
    return {
      content: [
        {
          type: "text",
          text: "Cannot resolve environment ID from P1_MCP_URL; set P1_MCP_URL with an /admin/<uuid>/mcp URL or set P1_ENVIRONMENT_ID.",
        },
      ],
      isError: true,
    };
  }

  try {
    // Token: env override → cache → refresh → one-time browser flow.
    const auth = accessToken
      ? { token: accessToken, via: "env" as const }
      : await resolveToken(
          envIdFromMcpUrl(
            process.env.P1_MCP_URL ?? "https://mcp.pingone.com/admin/2087f9ab-c416-45c4-92f1-22bbc894407c/mcp",
          ) ?? "",
          process.env.P1_MCP_URL ?? "",
        );

    const sessionIdArg =
      typeof args?.sessionId === "string" ? args.sessionId : undefined;

    // Live visibility: emit MCP progress notifications as the specialist
    // works (tool calls + narration), so clients that support progress
    // show what's happening in real time.
    const onEvent = (e: SpecialistEvent) => {
      let line: string;
      switch (e.kind) {
        case "init":
          line = `starting — mcp ${e.servers}, ${e.visibleMcpTools} tools in scope`;
          break;
        case "tool_call":
          line = `→ ${e.name.replace(/^mcp__pingone__/, "")} ${e.argsPreview}`;
          break;
        case "text":
          line = e.text.split("\n")[0].slice(0, 160);
          break;
        case "done":
          line = e.isError
            ? `finished with ERROR after ${e.toolCalls} tool calls`
            : `finished ok after ${e.toolCalls} tool calls`;
          break;
      }
      void server
        .notification({
          method: "notifications/progress",
          params: {
            progressToken: `${def.name}-${Date.now()}`,
            progress: 0,
            total: 1,
            message: line,
          },
        })
        .catch(() => {});
    };

    const out = await launchSpecialist(
      { intent, environmentId: envId, sessionId: sessionIdArg },
      def,
      { onEvent },
    );

    const lines = [
      out.report,
      "",
      `--- specialist: ${def.name} | ${out.isError ? "FAILED" : "ok"} | ${out.toolCalls.length} tool calls in ${out.toolArgs.length} steps`,
    ];
    out.toolCalls.forEach((c, i) => {
      lines.push(`---   ${c} ${out.toolArgs[i] ?? ""}`);
    });
    lines.push(`--- run log: ${out.logPath}`);
    if (out.sessionId) {
      lines.push(`--- session: ${out.sessionId} (pass back to continue)`);
    }
    if (out.diagnostics) {
      lines.push(`--- diagnostics: ${out.diagnostics}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Specialist launch failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("p1-orchestrator ready (specialists:", SPECIALISTS.length + ")");
