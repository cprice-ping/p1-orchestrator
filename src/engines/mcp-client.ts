/**
 * engines/mcp-client.ts — a tiny stateful MCP client over streamable HTTP:
 * initialize once, then tools/list and tools/call with the session id.
 * Extracted from launch.ts's inline fetchToolCatalog so both engines share
 * one MCP transport.
 */

export interface ToolCallPayload {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

export class McpToolClient {
  private sessionId?: string;
  private nextId = 1;

  constructor(
    private url: string,
    private token: string,
  ) {}

  private async rpc(method: string, params?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params: params ?? {},
      }),
    });

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    const body = await res.text();
    if (!res.ok) throw new Error(`MCP ${method} failed: ${res.status} ${body.slice(0, 300)}`);

    // Streamable HTTP may reply as SSE; take the first data: line.
    let jsonText = body;
    if (body.startsWith("event:") || body.includes("\ndata:")) {
      const m = body.match(/data: (.+)/);
      if (m) jsonText = m[1];
    }
    try {
      const j = JSON.parse(jsonText);
      if (j.error) throw new Error(`MCP ${method} error: ${JSON.stringify(j.error).slice(0, 300)}`);
      return j.result;
    } catch {
      throw new Error(`MCP ${method}: unparseable response: ${jsonText.slice(0, 300)}`);
    }
  }

  async init(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "p1-orchestrator", version: "0.1.0" },
    });
    // initialized notification (no id, no response expected)
    await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.token}`,
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  }

  /** Full catalog: tool name -> { description, inputSchema }. */
  async listTools(): Promise<Record<string, { description?: string; inputSchema: unknown }>> {
    await this.init();
    const result = (await this.rpc("tools/list", {})) as {
      tools?: { name: string; description?: string; inputSchema?: unknown }[];
    };
    const map: Record<string, { description?: string; inputSchema: unknown }> = {};
    for (const t of result.tools ?? []) {
      map[t.name] = { description: t.description, inputSchema: t.inputSchema ?? {} };
    }
    return map;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallPayload> {
    // Lazy session: some servers (docs.pingidentity.com) reject tools/call
    // without a session established by initialize.
    if (!this.sessionId) await this.init();
    const result = (await this.rpc("tools/call", { name, arguments: args })) as ToolCallPayload;
    return result;
  }

  /** Release the session (idempotent). */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = undefined;
    try {
      await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.token}`,
          "mcp-session-id": sid,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }),
      }).catch(() => {});
    } catch {
      /* best-effort teardown */
    }
  }
}
