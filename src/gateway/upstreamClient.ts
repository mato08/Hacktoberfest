import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolRequest, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamServerConfig } from "../config.js";

export interface UpstreamMcpClient {
  connect(): Promise<void>;
  listTools(): Promise<Tool[]>;
  callTool(params: CallToolRequest["params"], signal?: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
}

export class StdioUpstreamClient implements UpstreamMcpClient {
  private readonly client = new Client({ name: "intent-gateway-upstream", version: "0.2.0" });
  constructor(private readonly config: UpstreamServerConfig) {}

  async connect() {
    // SDK uses cross-spawn, handling npx/npm .cmd shims on Windows. Prefer node
    // + an absolute script path; explicit cmd /c is accepted as trusted host config.
    const transport = new StdioClientTransport({ ...this.config, stderr: "inherit" });
    // SDK inherits a safe OS allowlist. Do not pass gateway/Jev secrets upstream.
    try { await this.client.connect(transport, { timeout: 30_000 }); }
    catch (error) { await this.client.close(); throw error; }
  }

  async listTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Upstream repeated a tools/list cursor.");
      if (cursor) cursors.add(cursor);
      if (tools.length > 10_000) throw new Error("Upstream tool discovery exceeded 10,000 tools.");
    } while (cursor);
    return tools;
  }

  async callTool(params: CallToolRequest["params"], signal?: AbortSignal): Promise<CallToolResult> {
    // Forward original params, including _meta. request avoids output wrapping.
    return this.client.request({ method: "tools/call", params }, CallToolResultSchema, { signal, timeout: 60_000 });
  }

  close() { return this.client.close(); }
}
