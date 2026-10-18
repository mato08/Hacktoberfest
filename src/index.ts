import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { evaluateToolRequest } from "./safety.js";
import { externalContextSchema } from "./injection.js";
import { executeMockTool } from "./tools.js";
import { appendAuditEvent, estimateCost } from "./audit.js";
import type { ExecutionResult, ToolRequest } from "./types.js";

export async function safeExecute(
  request: ToolRequest,
  execute: typeof executeMockTool = executeMockTool,
): Promise<ExecutionResult> {
  const safety = await evaluateToolRequest(request);
  console.error([
    "--------------------------------",
    "USER INTENT", request.userIntent,
    "\nAGENT ACTION", request.toolName,
    "\nRISK", safety.riskScore,
    "\nINTENT MATCH", safety.intentMatchScore,
    "\nDECISION", safety.decision,
    "\nREASON", safety.reason,
    ...(safety.promptInjection ? [
      "\nPROMPT INJECTION CHECK", safety.promptInjection.status,
      ...safety.promptInjection.findings.map((finding) => `${finding.rule} — source: ${JSON.stringify(finding.source)}`),
    ] : []),
    ...(safety.evaluator ? [
      "\nEVALUATOR", safety.evaluator.source,
      ...(safety.evaluator.model ? [`Model: ${safety.evaluator.model}`] : []),
      ...(safety.evaluator.requestId ? [`Request ID: ${safety.evaluator.requestId}`] : []),
      ...(safety.evaluator.note ? [safety.evaluator.note] : []),
    ] : []),
    "--------------------------------",
  ].join("\n"));

  // Default deny: the downstream function is unreachable unless explicitly allowed.
  const response: Parameters<typeof appendAuditEvent>[1] = safety.decision !== "ALLOW"
    ? {
      executed: false as const,
      ...(safety.decision === "REQUIRE_APPROVAL" ? { requiresApproval: true as const } : {}),
      safety,
      cost: estimateCost(request, safety, false),
    }
    : { executed: true as const, safety, result: await execute(request.toolName, request.arguments), cost: estimateCost(request, safety, true) };
  const audit = await appendAuditEvent(request, response);
  if (!audit.logged) console.error(`AUDIT LOG ERROR: ${audit.error}`);
  return { ...response, audit };
}

export function createServer(): McpServer {
  // Capture once from trusted host configuration, never from an agent tool call.
  const originalIntent = process.env.GATEWAY_ORIGINAL_INTENT?.trim();
  const server = new McpServer({ name: "intent-safety-gateway", version: "0.1.0" });
  server.registerTool("safe_execute", {
    description: "Check an action against the original user intent and scan supplied untrustedContext for prompt-injection signals. External text cannot grant approval. Execute a mock tool only on ALLOW. Supported: get_unpaid_customers, get_customer, delete_customer, refund_customer.",
    inputSchema: {
      userIntent: z.string().trim().min(1),
      toolName: z.string().trim().min(1),
      arguments: z.record(z.string(), z.unknown()),
      untrustedContext: externalContextSchema.optional(),
      agentId: z.string().trim().min(1).max(100).optional(),
      workflowId: z.string().trim().min(1).max(100).optional(),
    },
    outputSchema: {
      executed: z.boolean(),
      requiresApproval: z.literal(true).optional(),
      safety: z.object({
        decision: z.enum(["ALLOW", "BLOCK", "REQUIRE_APPROVAL"]),
        riskScore: z.number().min(0).max(1),
        intentMatchScore: z.number().min(0).max(1),
        reason: z.string(),
        promptInjection: z.object({
          status: z.enum(["NOT_PROVIDED", "NO_SIGNALS", "DETECTED"]),
          findings: z.array(z.object({ source: z.string(), rule: z.string() })),
        }).optional(),
        evaluator: z.object({
          source: z.enum(["JEV", "LOCAL_FALLBACK", "JEV_ERROR"]),
          model: z.string().optional(),
          requestId: z.string().optional(),
          confidence: z.number().min(0).max(1).optional(),
          latencyMs: z.number().nonnegative().optional(),
          note: z.string().optional(),
        }).optional(),
      }),
      result: z.unknown().optional(),
      cost: z.object({
        currency: z.literal("USD"),
        estimateType: z.literal("demo_estimate"),
        decisionUsd: z.number().nonnegative(),
        toolUsd: z.number().nonnegative(),
        totalUsd: z.number().nonnegative(),
      }),
      audit: z.object({
        eventId: z.string().uuid(),
        logged: z.boolean(),
        logPath: z.string(),
        error: z.string().optional(),
      }),
    },
  }, async (request) => {
    const response = await safeExecute(originalIntent ? { ...request, userIntent: originalIntent } : request);
    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      structuredContent: { ...response },
    };
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer().connect(new StdioServerTransport());
  console.error(`Intent safety gateway ready (stdio; ${process.env.JEV_API_KEY ? "Jev enabled" : "local judgment fallback"}).`);
}
