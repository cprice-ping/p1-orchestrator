/**
 * launch.ts — spawn one specialist agent loop and return its report.
 *
 * Generic across specialists: everything specialist-specific lives in the
 * registry (description, tools, playbook). This file is small on purpose;
 * the transferable logic is data, not code.
 *
 * Tool filtering is dynamic: we fetch the live tool catalog from the P1 MCP
 * server (JSON-RPC tools/list) and deny the complement of the specialist's
 * subset. Adding tools upstream changes nothing here.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SpecialistDef } from "./registry.js";
import { MCP_SERVER_NAME, SHARED_RULES, isDestructiveTool } from "./registry.js";
import { resolveToken } from "./auth.js";
import { gatherContext } from "./corpus.js";
import type { Topic } from "./corpus.js";
import { runPingcli } from "./pingcli-bridge.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { FallbackSpec } from "./pingcli-bridge.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpToolClient } from "./engines/mcp-client.js";

export interface LaunchInput {
  authorizeMode?: "inspect" | "author" | "deploy" | "evaluate";
  intent: string;
  environmentId: string;
  /** Follow-up instruction on an existing specialist session. */
  followUp?: string;
  sessionId?: string;
  maxTurns?: number;
  /** Caller opt-in for delete* tools. Off by default: the gate denies them. */
  allowDestructive?: boolean;
}

/** Streaming progress events, for live visibility into a running specialist. */
export type SpecialistEvent =
  | { kind: "init"; servers: string; visibleMcpTools: number }
  | { kind: "tool_call"; name: string; argsPreview: string }
  | { kind: "text"; text: string }
  | { kind: "done"; isError: boolean; toolCalls: number; ms: number };

export interface LaunchCallbacks {
  onEvent?: (e: SpecialistEvent) => void;
}

export interface LaunchOutput {
  sessionId: string;
  report: string;
  toolCalls: string[];
  /** One-line JSON arg preview per tool call, aligned with toolCalls. */
  toolArgs: string[];
  isError: boolean;
  /** Diagnostic detail on failure (init statuses etc.). */
  diagnostics?: string;
  /** Path to the persisted NDJSON run log. */
  logPath: string;
  /** Tool calls the gate refused (tool name + reason), for the caller. */
  denied?: { tool: string; reason: string }[];
}

/**
 * Fetch the tool catalog from the remote MCP server via raw JSON-RPC
 * (initialize + tools/list). Used to compute the deny-complement and to
 * validate subsets against reality at startup.
 */
export async function fetchToolCatalog(
  url: string,
  accessToken: string,
): Promise<string[]> {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`,
  };

  const post = (body: unknown, sessionId?: string) =>
    fetch(url, {
      method: "POST",
      headers: sessionId ? { ...headers, "mcp-session-id": sessionId } : headers,
      body: JSON.stringify(body),
    });

  // initialize
  const initRes = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "p1-orchestrator", version: "0.1.0" },
    },
  });
  if (!initRes.ok) {
    throw new Error(
      `MCP initialize failed: ${initRes.status} ${await initRes.text()}`,
    );
  }
  const session = initRes.headers.get("mcp-session-id") ?? undefined;
  await initRes.text(); // drain

  // initialized notification
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);

  // tools/list
  const listRes = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    session,
  );
  if (!listRes.ok) {
    throw new Error(
      `MCP tools/list failed: ${listRes.status} ${await listRes.text()}`,
    );
  }
  const body = (await listRes.json()) as {
    result?: { tools?: { name: string }[] };
  };
  return (body.result?.tools ?? []).map((t) => t.name);
}

/**
 * Complement of the specialist's subset, in mcp__server__tool form.
 */
export function computeDenyList(
  allTools: string[],
  subset: readonly string[],
): string[] {
  const allowed = new Set(subset);
  return allTools
    .filter((t) => !allowed.has(t))
    .map((t) => `mcp__${MCP_SERVER_NAME}__${t}`);
}

/** Default MCP URL shape — the admin env must be supplied (P1_MCP_URL). */
export const DEFAULT_P1_MCP_URL = "";

/** Extract the admin env UUID from an mcp.pingone.com URL. */
export function envIdFromMcpUrl(url: string): string | undefined {
  const m = url.match(/\/admin\/([0-9a-f-]{36})\/mcp/);
  return m?.[1];
}

/** Which model runtime executes specialist loops. Selected by
 *  SPECIALIST_ENGINE: "claude" (default) or "gemini". */
export type EngineName = "claude" | "gemini";

export function currentEngine(): EngineName {
  const e = (process.env.SPECIALIST_ENGINE ?? "claude").toLowerCase();
  if (e !== "claude" && e !== "gemini") {
    throw new Error(`Unknown SPECIALIST_ENGINE '${e}' (use "claude" or "gemini")`);
  }
  return e;
}

/**
 * Engine dispatch. The registry (playbook, subset, description) is identical
 * for both; only loop mechanics differ. Callers stay engine-agnostic.
 *
 * Situational context: before dispatch, gather distilled doc context for
 * the intent (orchestrator = retrieval layer). Both engines receive the
 * same context block; specialists treat it as facts-to-inform, with the
 * tool catalog + P1 enforcement as ground truth.
 */
export async function launchSpecialist(
  input: LaunchInput,
  def: SpecialistDef,
  callbacks?: LaunchCallbacks,
): Promise<LaunchOutput> {
  if (def.transport === "authorize-cli") {
    const { launchAuthorize } = await import("./authorize/launch.js");
    return launchAuthorize(input, def, callbacks);
  }
  let corpusContext = "";
  if (!input.sessionId && def.topics?.length) {
    try {
      const docs = await gatherContext(input.intent, def.topics as Topic[]);
      if (docs.length) {
        corpusContext = [
          "",
          "SITUATIONAL CONTEXT (sourced from Ping's agent-ready doc corpus, developer.pingidentity.com):",
          "Treat as authoritative guidance for THIS task; if it conflicts with what the tools return, report the conflict rather than forcing an action.",
          "",
          ...docs.flatMap((d) => [
            `## ${d.title}`,
            `source: ${d.url}`,
            d.excerpt,
            "",
          ]),
        ].join("\n");
        callbacks?.onEvent?.({
          kind: "text",
          text: `[orchestrator] gathered ${docs.length} doc context(s): ${docs.map((d) => d.title).join(", ")}`,
        });
      }
    } catch (err) {
      // Corpus is best-effort: never block the specialist on retrieval.
      console.error("[corpus] gather failed:", err instanceof Error ? err.message : err);
    }
  }
  const inputWithContext = { ...input, _corpusContext: corpusContext } as LaunchInput & { _corpusContext?: string };

  if (currentEngine() === "gemini") {
    const { launchSpecialistGemini } = await import("./engines/gemini.js");
    return launchSpecialistGemini(inputWithContext, def, callbacks);
  }
  return launchSpecialistClaude(inputWithContext, def, callbacks);
}

async function launchSpecialistClaude(
  input: LaunchInput,
  def: SpecialistDef,
  callbacks?: LaunchCallbacks,
): Promise<LaunchOutput> {
  const url = process.env.P1_MCP_URL ?? DEFAULT_P1_MCP_URL;

  // Resolve the token at call time: env override → cached → refresh →
  // one-time browser flow (same pre-wired client the P1 MCP server uses).
  const auth = await resolveToken(envIdFromMcpUrl(url) ?? "", url);
  const accessToken = auth.token;

  // The P1 connection lives in THIS process: the specialist's runtime (a
  // child `claude` process) reaches PingOne only through the in-process
  // proxy below, so the bearer token never crosses a process boundary
  // (an http mcpServers entry would put it in the child's argv, readable
  // by any same-user process via ps).
  const p1 = new McpToolClient(url, accessToken);
  const catalog = await p1.listTools();
  const allTools = Object.keys(catalog);

  // Dual-source subset: catalog hits → native MCP; catalog misses with a
  // fallback mapping (e.g. Protect via pingcli) → CLI bridge tools.
  const inCatalog = new Set(allTools);
  const missing = def.tools.filter((t) => !inCatalog.has(t));
  const fallbacks = def.fallback ?? {};
  const cliBridgeTools = missing.filter((t) => fallbacks[t]);
  const unresolvable = missing.filter((t) => !fallbacks[t]);
  if (unresolvable.length) {
    await p1.close().catch(() => {});
    throw new Error(
      `Specialist '${def.name}' references tools missing from the catalog with no fallback: ${unresolvable.join(", ")}`,
    );
  }
  const effectiveSubset = def.tools.filter((t) => inCatalog.has(t) || !!fallbacks[t]);

  const disallowed = computeDenyList(allTools, effectiveSubset.filter((t) => inCatalog.has(t)));
  const allowed = new Set([
    ...effectiveSubset.filter((t) => inCatalog.has(t)).map((t) => `mcp__${MCP_SERVER_NAME}__${t}`),
    ...cliBridgeTools.map((t) => `mcp__pingcli__${t}`),
  ]);

  // One gate for every tool call, enforced in orchestrator code: only the
  // specialist's subset, and delete* only with allowDestructive. Refusals
  // are recorded so the orchestrator (not the specialist) reports them.
  const denied: { tool: string; reason: string }[] = [];
  const gate = (toolName: string): string | null => {
    let reason: string | null = null;
    if (!allowed.has(toolName)) {
      reason = `${toolName} is outside this specialist's tool set.`;
    } else if (isDestructiveTool(toolName) && !input.allowDestructive) {
      reason =
        `${toolName} is destructive and this dispatch did not set allowDestructive. ` +
        "Do not retry or work around this; report what you would delete so the caller can re-dispatch with allowDestructive.";
    }
    if (reason) denied.push({ tool: toolName.replace(/^mcp__\w+?__/, ""), reason });
    return reason;
  };

  // In-process proxy for the P1 subset: the live catalog's own descriptions
  // and JSON Schemas, forwarded over this process's MCP session.
  const p1Subset = effectiveSubset.filter((t) => inCatalog.has(t));
  const p1Proxy = new McpServer(
    { name: MCP_SERVER_NAME, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  p1Proxy.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: p1Subset.map((name) => ({
      name,
      description: catalog[name].description ?? "",
      inputSchema: catalog[name].inputSchema as { type: "object" },
    })),
  }));
  p1Proxy.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (!p1Subset.includes(name)) {
      return { content: [{ type: "text", text: `${name} is outside this specialist's tool set.` }], isError: true };
    }
    try {
      return (await p1.callTool(name, req.params.arguments ?? {})) as never;
    } catch (err) {
      return { content: [{ type: "text", text: `TOOL ERROR: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  const task = input.followUp ?? input.intent;
  const corpusCtx = (input as LaunchInput & { _corpusContext?: string })._corpusContext ?? "";
  const prompt = [
    `environmentId: ${input.environmentId}`,
    "",
    "Task:",
    task,
    ...(corpusCtx ? [corpusCtx] : []),
  ].join(
    "\n",
  );

  const options: Record<string, unknown> = {
    settingSources: [], // clean-room: no Claude Code settings/skills/CLAUDE.md
    systemPrompt: `${SHARED_RULES}\n\n${def.playbook}`,
    // Model resolution: specialist override → deployment override
    // (P1_SPECIALIST_MODEL) → inherit the orchestrator's own model env.
    model: def.model ?? process.env.P1_SPECIALIST_MODEL ?? process.env.ANTHROPIC_MODEL,
    maxTurns: input.maxTurns ?? 20,
    mcpServers: {
      [MCP_SERVER_NAME]: { type: "sdk", name: MCP_SERVER_NAME, instance: p1Proxy },
      // CLI bridge: fallback tools that shell out to pingcli for domains
      // the MCP catalog doesn't carry (Protect today).
      ...(cliBridgeTools.length
        ? {
            pingcli: createSdkMcpServer({
              name: "pingcli",
              version: "0.1.0",
              tools: cliBridgeTools.map((name) =>
                tool(
                  name,
                  (fallbacks as FallbackSpec)[name].description,
                  {
                    environmentId: z.string().optional().describe("Overrides the injected environment ID"),
                    body: z.string().optional().describe("Full JSON body for create/replace operations"),
                    positional: z.array(z.string()).optional().describe("Positional CLI arguments, e.g. the resource ID"),
                  },
                  async ({ environmentId, body, positional }) => {
                    const r = await runPingcli((fallbacks as FallbackSpec)[name].args, {
                      environmentId: environmentId ?? input.environmentId,
                      stdinBody: body,
                      positional,
                    });
                    return {
                      content: [{ type: "text", text: r.text }],
                      isError: !r.ok,
                    };
                  },
                ),
              ),
            }),
          }
        : {}),
    },
    // No built-in tools (Bash, Read, Write, WebFetch…): the specialist's
    // only capabilities are the MCP subset below.
    tools: [],
    disallowedTools: disallowed,
    // Headless, nobody to prompt: every tool call goes through this gate.
    // Only the specialist's subset may run, and delete* only when the
    // caller dispatched with allowDestructive. Fail-closed.
    permissionMode: "default",
    canUseTool: async (toolName: string, toolInput: Record<string, unknown>) => {
      const reason = gate(toolName);
      return reason
        ? { behavior: "deny", message: reason }
        : { behavior: "allow", updatedInput: toolInput };
    },
  };

  if (input.sessionId) {
    options.resume = input.sessionId;
  }

  let sessionId = "";
  const toolCalls: string[] = [];
  const toolArgs: string[] = [];
  let report = "";
  let isError = false;
  let diagnostics = "";
  const t0 = Date.now();

  // Persisted run log: ~/.p1-orchestrator/runs/<ts>-<specialist>.jsonl
  const runsDir = join(homedir(), ".p1-orchestrator", "runs");
  await mkdir(runsDir, { recursive: true });
  const logPath = join(
    runsDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${def.name}.ndjson`,
  );
  const log = (obj: unknown) =>
    appendFile(logPath, JSON.stringify(obj) + "\n").catch(() => {});

  const emit = (e: SpecialistEvent) => callbacks?.onEvent?.(e);

  try {
    for await (const message of query({ prompt, options: options as never })) {
      if (message.type === "system" && message.subtype === "init") {
        const init = message as unknown as {
          session_id?: string;
          mcp_servers?: { name: string; status: string }[];
          tools?: string[];
        };
        sessionId = init.session_id ?? "";
        if (init.mcp_servers) {
          diagnostics += init.mcp_servers
            .map((s) => `${s.name}:${s.status}`)
            .join(",");
        }
        let visible = 0;
        if (init.tools) {
          visible = init.tools.filter((t) => t.startsWith("mcp__")).length;
          diagnostics += ` | visible_mcp_tools=${visible}`;
        }
        const initEvt: SpecialistEvent = {
          kind: "init",
          servers: diagnostics.split(" |")[0],
          visibleMcpTools: visible,
        };
        await log({ ts: new Date().toISOString(), event: "init", ...initEvt });
        emit(initEvt);
      }

      if (message.type === "assistant") {
        const content = (message as { message?: { content?: unknown[] } })
          .message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const b = block as {
              type?: string;
              name?: string;
              input?: unknown;
              text?: string;
            };
            if (b.type === "tool_use") {
              const name = b.name ?? "?";
              toolCalls.push(name);
              // Compact arg preview: first ~120 chars of the interesting bits.
              const preview = JSON.stringify(b.input ?? {}) // structured per call
                .replace(/environmentId":"[^"]+"/g, 'environmentId":"…"')
                .slice(1, 140);
              toolArgs.push(preview);
              await log({
                ts: new Date().toISOString(),
                event: "tool_call",
                name,
                argsPreview: preview,
              });
              emit({ kind: "tool_call", name, argsPreview: preview });
            } else if (b.type === "text" && b.text?.trim()) {
              await log({
                ts: new Date().toISOString(),
                event: "text",
                text: b.text.slice(0, 500),
              });
              emit({ kind: "text", text: b.text });
            }
          }
        }
      }

      if (message.type === "result") {
        const res = message as unknown as {
          subtype?: string;
          session_id?: string;
          result?: string;
        };
        sessionId = res.session_id ?? sessionId;
        isError = res.subtype !== "success";
        report = res.result ?? "";
        if (isError) diagnostics += ` | result=${res.subtype}`;
        await log({
          ts: new Date().toISOString(),
          event: "done",
          isError,
          report,
          sessionId,
        });
        emit({
          kind: "done",
          isError,
          toolCalls: toolCalls.length,
          ms: Date.now() - t0,
        });
      }
    }

  } finally {
    await p1.close().catch(() => {});
  }

  return { sessionId, report, toolCalls, toolArgs, isError, diagnostics, logPath, denied };
}
