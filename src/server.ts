/**
 * server.ts — the Orchestrator MCP server ("Shape B").
 *
 * Exposes one tool per specialist plus a discovery tool. Every tool call:
 *   1. validates args (typed boundary),
 *   2. launches a specialist agent loop (fresh or resumed),
 *   3. returns the specialist's compact report.
 *
 * The orchestrator model never sees raw P1 tools; it sees 3 one-liners.
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
import { listAll } from "./registry.js";
import { resolveToken } from "./auth.js";
import { envIdFromMcpUrl } from "./launch.js";
import { McpToolClient } from "./engines/mcp-client.js";

const server = new Server(
  { name: "p1-orchestrator", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// FIXED-SURFACE exposure: the client sees three fixed tools, forever.
// Specialists are discovered via the directory (list_specialists) and
// invoked via dispatch_specialist — so adding a specialist is a data drop
// that surfaces in the directory's OUTPUT, never in the tool listing.
// resolve_environment is plumbing, not a specialist: env selection is one
// tool call, so it gets one tool — no LLM hop. No client renegotiation,
// ever: fixed contract, dynamic content.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_specialists",
        description:
          "List available PingOne specialists with their exact scopes of competence. Call this first when the task could be handled by a specialist, then dispatch_specialist with the chosen name.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "dispatch_specialist",
        description:
          "Invoke a PingOne specialist by name to complete a task. Route with list_specialists first; pass the specialist's name and a precise intent. Use sessionId to continue a previous conversation with the same specialist.",
        inputSchema: {
          type: "object" as const,
          properties: {
            specialist: {
              type: "string",
              description:
                "The specialist name from list_specialists (e.g. app_onboarding).",
            },
            intent: {
              type: "string",
              description:
                "What to do, in one or two sentences. Include app/user/flow specifics and any URIs, names, or scopes.",
            },
            sessionId: {
              type: "string",
              description:
                "Optional: a session_id returned by a previous dispatch of the same specialist, to continue that conversation instead of starting fresh.",
            },
            environmentId: {
              type: "string",
              description:
                "Optional: the PingOne environment to act on (UUID). Omit to use the deployment default (P1_ENVIRONMENT_ID, else the admin env from P1_MCP_URL). The caller's PingOne permissions decide what is actually reachable — specialists act on whichever env the intent names.",
            },
          },
          required: ["specialist", "intent"],
        },
      },
      {
        name: "resolve_environment",
        description:
          "List the PingOne environments this deployment's identity can reach (id, name, type). Use when no environment is known for a task: pick the right one here, then pass it as dispatch_specialist's environmentId. Pure lookup — no specialist involved.",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "list_specialists") {
    const all = await listAll();
    return {
      content: [
        {
          type: "text",
          text: [
            "Available PingOne specialists — pick by task, dispatch with dispatch_specialist:",
            "",
            ...all.map((s) => `- ${s.name}: ${s.description}`),
            "",
            "If no specialist covers the task, say so rather than guessing; name the closest match and what's missing.",
          ].join("\n"),
        },
      ],
    };
  }

  // resolve_environment: pure lookup, no LLM. Auth (browser fallback
  // included), then one listEnvironments call through the live P1 MCP
  // catalog. The catalog decides what this identity may enumerate.
  if (name === "resolve_environment") {
    const mcpUrl = process.env.P1_MCP_URL;
    if (!mcpUrl) {
      return {
        content: [
          {
            type: "text",
            text: "P1_MCP_URL is not set; environment discovery needs the PingOne MCP server URL.",
          },
        ],
        isError: true,
      };
    }
    try {
      const { token } = await resolveToken(
        envIdFromMcpUrl(mcpUrl) ?? "",
        mcpUrl,
      );
      const client = new McpToolClient(mcpUrl, token);
      try {
        const catalog = await client.listTools();
        if (!("listEnvironments" in catalog)) {
          return {
            content: [
              {
                type: "text",
                text: "The connected PingOne MCP server does not expose listEnvironments — ask the caller for the environment ID instead.",
              },
            ],
            isError: true,
          };
        }
        const res = await client.callTool("listEnvironments", {});
        const text = res.content
          .map((c) => c.text ?? "")
          .join("\n");
        let envs: any[] = [];
        try {
          const parsed = JSON.parse(text);
          envs = parsed._embedded?.environments ?? [];
        } catch {
          return {
            content: [{ type: "text", text: `Unexpected listEnvironments response: ${text.slice(0, 400)}` }],
            isError: true,
          };
        }
        const defaultEnv =
          process.env.P1_ENVIRONMENT_ID ??
          envIdFromMcpUrl(mcpUrl) ??
          "(none — pass environmentId explicitly)";
        const lines = [
          "Environments reachable by this deployment's identity — pass one as dispatch_specialist's environmentId:",
          "",
          ...envs.map((e) => `- ${e.id}  ${e.name} (${e.type ?? "unknown type"}${e.region ? `, ${e.region}` : ""})`),
          "",
          `Deployment default (used when environmentId is omitted): ${defaultEnv}`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } finally {
        await client.close().catch(() => {});
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Environment lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  // dispatch_specialist: resolve the specialist from the DYNAMIC registry.
  const specialistName =
    typeof args?.specialist === "string" ? args.specialist.trim() : "";
  if (!specialistName) {
    return {
      content: [{ type: "text", text: "Missing required arg: specialist" }],
      isError: true,
    };
  }
  const def = (await listAll()).find((s) => s.name === specialistName);
  if (!def) {
    const all = await listAll();
    return {
      content: [
        {
          type: "text",
          text: `Unknown specialist '${specialistName}'. Available: ${all.map((s) => s.name).join(", ")}. Call list_specialists for descriptions.`,
        },
      ],
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
  // Task-target env, resolved per dispatch: explicit arg → P1_ENVIRONMENT_ID
  // (deployment default) → the admin env from the MCP URL. PingOne's own
  // per-env MCP enablement and the caller's roles decide what is reachable,
  // so a caller may name any env their identity can touch — no second pin.
  const envId =
    (typeof args?.environmentId === "string" && args.environmentId.trim()) ||
    process.env.P1_ENVIRONMENT_ID ||
    envIdFromMcpUrl(process.env.P1_MCP_URL ?? "");
  if (!envId) {
    return {
      content: [
        {
          type: "text",
          text: "Cannot resolve the task environment. Pass environmentId per dispatch, or set P1_ENVIRONMENT_ID / P1_MCP_URL (https://mcp.pingone.com/admin/<admin-env-uuid>/mcp).",
        },
      ],
      isError: true,
    };
  }

  try {
    // Token: env override → cache → refresh → one-time browser flow.
    // Login env: the MCP URL's admin env if configured, else the task env.
    const auth = accessToken
      ? { token: accessToken, via: "env" as const }
      : await resolveToken(
          envIdFromMcpUrl(process.env.P1_MCP_URL ?? "") ?? envId,
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
const loaded = await listAll();
console.error("p1-orchestrator ready (specialists:", loaded.length + ")");
