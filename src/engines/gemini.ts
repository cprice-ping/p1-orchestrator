/**
 * engines/gemini.ts — Gemini engine: the SAME registry data, a different
 * model runtime.
 *
 * Proves the architecture's central claim: specialists are model-independent
 * data (playbook, tool subset, description). Only the loop mechanics differ:
 *   - tools:     FunctionDeclaration[] via parametersJsonSchema (raw pass-through
 *                of the P1 MCP server's own JSON Schemas — no translation)
 *   - filtering: the subset is the ONLY tools sent, in the request. No
 *                deny-complement needed: the model literally can't call
 *                what it isn't offered.
 *   - loop:      generateContent → functionCalls → execute via MCP →
 *                functionResponse parts → repeat, until text-only turn.
 *
 * Auth: same resolveToken() path as the Claude engine — the P1 MCP server
 * doesn't care which model is driving the calls.
 */

import { GoogleGenAI } from "@google/genai";
import type { SpecialistDef } from "../registry.js";
import { SHARED_RULES } from "../registry.js";
import {
  fetchToolCatalog,
  DEFAULT_P1_MCP_URL,
} from "../launch.js";
import type { SpecialistEvent, LaunchOutput } from "../launch.js";
import type { LaunchCallbacks } from "../launch.js";
import { resolveToken } from "../auth.js";
import type { ToolCallPayload } from "./mcp-client.js";
import { McpToolClient } from "./mcp-client.js";

export interface GeminiLaunchInput {
  intent: string;
  environmentId: string;
  sessionId?: string; // honored as a no-op state: Gemini runs are stateless
  maxTurns?: number;
}

/** Names of the two P1 tools the registry expects every specialist to avoid
 *  needing (environmentId arrives resolved); enforced by omission. */
export async function launchSpecialistGemini(
  input: { intent: string; environmentId: string; maxTurns?: number },
  def: SpecialistDef,
  callbacks?: LaunchCallbacks,
): Promise<LaunchOutput> {
  const url = process.env.P1_MCP_URL ?? DEFAULT_P1_MCP_URL;
  const auth = await resolveToken(
    url.match(/\/admin\/([0-9a-f-]{36})\/mcp/)?.[1] ?? "",
    url,
  );

  const client = new McpToolClient(url, auth.token);
  const catalog = await client.listTools(); // name -> JSON Schema
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
  const model = process.env.P1_SPECIALIST_MODEL ?? "gemini-2.5-flash";

  // Subset declarations, straight from the live catalog's own schemas.
  const declarations = def.tools
    .filter((t) => catalog[t])
    .map((t) => ({
      name: t,
      description: catalog[t].description ?? "",
      parametersJsonSchema: stripEnvId(catalog[t].inputSchema),
    }));

  const missing = def.tools.filter((t) => !catalog[t]);
  if (missing.length) {
    throw new Error(
      `Specialist '${def.name}' references tools missing from the live catalog: ${missing.join(", ")}`,
    );
  }

  const systemInstruction = [
    SHARED_RULES,
    "",
    def.playbook,
    "",
    `You have exactly these tools: ${def.tools.join(", ")}. Nothing else exists.`,
    `environmentId for all calls: ${input.environmentId} (already known — never ask for it)`,
    `When the task is complete, reply with your final summary as plain text. Do not call tools after that.`,
  ].join("\n");

  const contents: { role: "user" | "model"; parts: unknown[] }[] = [
    { role: "user", parts: [{ text: `Task:\n${input.intent}` }] },
  ];

  const toolCalls: string[] = [];
  const toolArgs: string[] = [];
  let report = "";
  const t0 = Date.now();
  const maxTurns = input.maxTurns ?? 20;
  let turn = 0;

  for (; turn < maxTurns; turn++) {
    const resp = await ai.models.generateContent({
      model,
      contents: contents as never,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: declarations }],
        // Manual loop — the harness executes tools, not the SDK.
        automaticFunctionCalling: { disable: true },
      },
    });

    const calls = resp.functionCalls ?? [];
    const textParts: string[] = [];
    for (const c of resp.candidates?.[0]?.content?.parts ?? []) {
      if ((c as { text?: string }).text) {
        textParts.push((c as { text?: string }).text!);
      }
    }

    if (calls.length === 0) {
      report = textParts.join("\n").trim() || "(empty final response)";
      break;
    }

    // Execute every call against the P1 MCP server, collect responses.
    const responseParts: unknown[] = [];
    for (const call of calls) {
      const name = call.name ?? "";
      const args = { ...(call.args ?? {}) } as Record<string, unknown>;
      args.environmentId = input.environmentId;
      toolCalls.push(`mcp__pingone__${name}`);
      const preview = JSON.stringify(args).slice(0, 140);
      toolArgs.push(preview);
      callbacks?.onEvent?.({ kind: "tool_call", name: `mcp__pingone__${name}`, argsPreview: preview });

      let result: ToolCallPayload;
      try {
        result = await client.callTool(name, args);
      } catch (err) {
        result = {
          content: [{ type: "text", text: `TOOL ERROR: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
      const textOut = result.content
        .map((c) => (c.type === "text" ? c.text : "[non-text block]"))
        .join("\n")
        .slice(0, 20000); // bound context growth per call

      responseParts.push({
        functionResponse: {
          name,
          response: {
            // Gemini expects {output: ...} inside the response object.
            output: result.isError ? `ERROR: ${textOut}` : textOut,
          },
        },
      });
    }

    contents.push({ role: "model", parts: calls.map((c) => ({ functionCall: c })) });
    contents.push({ role: "user", parts: responseParts });
  }

  if (turn >= maxTurns && !report) {
    report = "(max turns reached without a final answer)";
  }

  callbacks?.onEvent?.({
    kind: "done",
    isError: !report || report.startsWith("("),
    toolCalls: toolCalls.length,
    ms: Date.now() - t0,
  });

  const logPath = await import("../runlog.js").then((m) =>
    m.writeRunLog(def.name, { toolCalls, toolArgs, report }),
  );

  return {
    sessionId: "", // stateless engine
    report,
    toolCalls,
    toolArgs,
    isError: report.startsWith("(") || report.startsWith("TOOL ERROR"),
    diagnostics: `engine=gemini model=${model} declarable_tools=${declarations.length}`,
    logPath,
  };
}

/** Gemini rejects some JSON-Schema keywords and chokes on un-required
 *  environmentId: strip it from schemas (we inject it) and drop $schema. */
function stripEnvId(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const s = { ...(schema as Record<string, unknown>) };
  delete (s as Record<string, unknown>).$schema;
  delete (s as Record<string, unknown>).additionalProperties;
  const props = s.properties as Record<string, unknown> | undefined;
  if (props && "environmentId" in props) {
    const p = { ...props };
    delete p.environmentId;
    s.properties = p;
    if (Array.isArray(s.required)) {
      s.required = (s.required as string[]).filter((r) => r !== "environmentId");
    }
  }
  return s;
}
