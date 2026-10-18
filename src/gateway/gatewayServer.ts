import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GatewayConfig } from "../config.js";
import { IntentContext } from "../context/intentContext.js";
import { ToolProxy, deniedResponse } from "./toolProxy.js";
import { StdioUpstreamClient, type UpstreamMcpClient } from "./upstreamClient.js";
import { appendAuditEvent, estimateCost } from "../audit.js";
import type { SafetyResult, ToolRequest } from "../types.js";
import { startReviewServer } from "../approval/reviewServer.js";

const intentSchema = z.strictObject({ intent: z.string().trim().min(1).max(8000) });
const intentTool: Tool = {
  name: "set_user_intent",
  description: "Initialize and lock the user's ORIGINAL task once for this gateway session, before reading external content. Cannot replace an existing intent. Host-configured intent takes precedence; start a new session for a new task.",
  inputSchema: { type: "object", properties: { intent: { type: "string", minLength: 1, maxLength: 8000 } }, required: ["intent"], additionalProperties: false },
};
const statusSchema = z.strictObject({ id: z.string().uuid() });
const statusTool: Tool = {
  name: "get_approval_status",
  description: "Read the status and final result of an action awaiting local human review. This tool cannot approve actions. Do not resubmit a pending or completed action; use its existing approval id.",
  inputSchema: { type: "object", properties: { id: { type: "string", format: "uuid" } }, required: ["id"], additionalProperties: false },
};

export async function createGateway(config: GatewayConfig, upstream: UpstreamMcpClient = new StdioUpstreamClient(config.upstream)) {
  await upstream.connect();
  try {
    const tools = await upstream.listTools();
    console.error(`Connected to upstream MCP server.\nDiscovered tools (${tools.length}):\n${tools.map(t => `  ${t.name}`).join("\n")}`);
    const context = new IntentContext(config.originalIntent);
    const proxy = new ToolProxy(tools, upstream, context, config);
    // Low-level SDK Server preserves arbitrary upstream JSON Schema without
    // converting it to Zod or rebuilding tool definitions by hand.
    const server = new Server({ name: "intent-safety-gateway", version: "0.2.0" }, {
      capabilities: { tools: {} },
      instructions: "Tool calls are checked against the original user task. Set it once with set_user_intent unless the host preconfigured it. BLOCK and REQUIRE_APPROVAL do not execute. This MVP has no agent-callable approval bypass.",
    });
    // Ordered per session: concurrent requests cannot race intent initialization
    // or skip observations of the previous upstream result.
    let queue: Promise<unknown> = Promise.resolve();
    const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
      const job = queue.then(work);
      queue = job.catch(() => undefined);
      return job;
    };
    const review = config.review ? await startReviewServer({ port: config.review.port,
      list: () => proxy.approvals.list(),
      decide: (id, fingerprint, decision) => enqueue(() => proxy.reviewAction(id, fingerprint, decision)),
    }) : undefined;
    if (review) console.error(`Local review dashboard: ${review.url}\nKeep this private link with the human reviewer; do not put it in agent prompts.`);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...proxy.listTools(), intentTool, ...(review ? [statusTool] : [])] }));
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => enqueue(async () => {
        const statusRequest = Boolean(review) && request.params.name === statusTool.name;
        if (request.params.name !== intentTool.name && !statusRequest) return proxy.handleToolCall(request.params, extra.signal);
        const controlTool = statusRequest ? statusTool : intentTool;
        let result: CallToolResult;
        let safety: SafetyResult;
        try {
          if (extra.signal.aborted || request.params.task) throw new Error("Cancelled or unsupported asynchronous control request.");
          if (statusRequest) {
            const { id } = statusSchema.parse(request.params.arguments);
            const record = proxy.approvals.get(id);
            const status = { id, status: record.status, expiresAt: record.expiresAt, note: record.note, result: record.result };
            result = { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
            safety = { decision: "ALLOW", riskScore: 0, intentMatchScore: 1, reason: "Read-only approval status; no upstream call." };
          } else {
            const { intent } = intentSchema.parse(request.params.arguments);
            context.setUserIntent(intent);
            console.error(`Original user intent locked: ${intent}`);
            result = { content: [{ type: "text" as const, text: `Original intent locked: ${context.userIntent}` }] };
            safety = { decision: "ALLOW", riskScore: 0, intentMatchScore: 1, reason: "Gateway session intent initialized; no upstream call." };
          }
        } catch (error) {
          safety = { decision: "BLOCK", riskScore: 1, intentMatchScore: 0, reason: error instanceof Error ? error.message : "Invalid intent." };
          result = deniedResponse(controlTool.name, safety);
        }
        const auditRequest: ToolRequest = { userIntent: context.userIntent, toolName: controlTool.name,
          arguments: request.params.arguments ?? {}, toolMetadata: controlTool,
          toolRisk: { operation: statusRequest ? "read" : "write", riskLevel: "medium", reason: "Gateway-local session control." }, agentId: config.agentId, workflowId: config.workflowId };
        const cost = estimateCost(auditRequest, safety, false);
        if (statusRequest) { cost.decisionUsd = 0; cost.totalUsd = 0; }
        const audit = await appendAuditEvent(auditRequest, { executed: false, result, safety, cost });
        if (!audit.logged) console.error(`AUDIT LOG ERROR: ${audit.error}`);
        return result;
    }));
    let cleanup: Promise<unknown> | undefined;
    const release = () => {
      proxy.approvals.close();
      return cleanup ??= Promise.allSettled([review?.close(), upstream.close()]);
    };
    server.onclose = () => { void release(); };
    return { server, proxy, reviewUrl: review?.url, close: async () => { await release(); await server.close(); } };
  } catch (error) { await upstream.close(); throw error; }
}
