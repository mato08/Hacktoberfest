import type { CallToolRequest, CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import type { GatewayConfig } from "../config.js";
import { IntentContext } from "../context/intentContext.js";
import { classifyToolRisk } from "../riskClassifier.js";
import { evaluateToolRequest, safetyResultSchema } from "../safety.js";
import { appendAuditEvent, estimateCost } from "../audit.js";
import type { SafetyResult, ToolRequest, ToolRiskMetadata } from "../types.js";
import type { UpstreamMcpClient } from "./upstreamClient.js";
import { ApprovalError, ApprovalStore } from "../approval/approvalStore.js";

export type SafetyEvaluator = (request: ToolRequest, mode: "local" | "jev") => Promise<SafetyResult>;
interface DiscoveredTool { tool: Tool; risk: ToolRiskMetadata; validate?: JsonSchemaValidator<unknown> }

export function deniedResponse(name: string, safety: SafetyResult): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: [
      safety.decision === "REQUIRE_APPROVAL" ? "ACTION REQUIRES HUMAN APPROVAL" : "ACTION BLOCKED BY MCP SAFETY GATEWAY",
      `Tool: ${name}`, `Decision: ${safety.decision}`, `Risk: ${Math.round(safety.riskScore * 100)}%`,
      `Intent match: ${Math.round(safety.intentMatchScore * 100)}%`, `Reason: ${safety.reason}`, "Upstream Executed: NO",
      ...(safety.approval ? [`Approval ID: ${safety.approval.id}`, "A human must review this action in the local dashboard. Use get_approval_status to retrieve its result; do not resubmit it."] : []),
    ].join("\n") }],
    _meta: { safetyGateway: { ...safety, executed: false } },
  };
}

export class ToolProxy {
  private readonly catalog = new Map<string, DiscoveredTool>();
  readonly approvals: ApprovalStore;
  constructor(
    tools: Tool[],
    private readonly upstream: UpstreamMcpClient,
    readonly context: IntentContext,
    private readonly config: GatewayConfig,
    private readonly evaluator: SafetyEvaluator = evaluateToolRequest,
  ) {
    this.approvals = new ApprovalStore(config.review?.ttlMs);
    for (const tool of tools) {
      if (["set_user_intent", "get_approval_status"].includes(tool.name) || this.catalog.has(tool.name)) throw new Error(`Duplicate or reserved upstream tool name: ${tool.name}`);
      // One provider per schema avoids $id collisions across unrelated tools.
      let validate: JsonSchemaValidator<unknown> | undefined;
      try { validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema); }
      catch { console.error(`Schema for ${tool.name} is unsupported. Calls to it will be blocked.`); }
      this.catalog.set(tool.name, { tool: structuredClone(tool), risk: classifyToolRisk(tool), validate });
    }
  }

  listTools(): Tool[] { return structuredClone([...this.catalog.values()].map(entry => entry.tool)); }

  async executeUpstreamTool(params: CallToolRequest["params"], signal?: AbortSignal): Promise<CallToolResult> {
    return this.upstream.callTool(params, signal);
  }

  async handleToolCall(original: CallToolRequest["params"], signal?: AbortSignal): Promise<CallToolResult> {
    const params = structuredClone(original);
    const entry = this.catalog.get(params.name);
    const request: ToolRequest = {
      ...this.context.snapshot(), toolName: params.name, arguments: params.arguments ?? {},
      toolMetadata: entry?.tool ?? { name: params.name, inputSchema: { type: "object" } },
      toolRisk: entry?.risk ?? { operation: "unknown", riskLevel: "critical", reason: "Tool not discovered upstream." },
      agentId: this.config.agentId, workflowId: this.config.workflowId,
    };
    let safety: SafetyResult;
    try {
      const validation = entry?.validate?.(request.arguments);
      if (!entry || !validation?.valid) {
        safety = { decision: "BLOCK", riskScore: 1, intentMatchScore: 0,
          reason: !entry ? "Tool was not discovered on the upstream server." : `Invalid or unsupported input schema: ${validation?.errorMessage ?? "could not validate"}` };
      } else if (params.task) {
        safety = { decision: "BLOCK", riskScore: 1, intentMatchScore: 0, reason: "Asynchronous MCP tasks are not supported by this synchronous gateway MVP." };
      } else {
        // A broken/custom evaluator must never accidentally authorize execution.
        const evaluated = await this.evaluator(structuredClone(request), this.config.evaluator);
        safetyResultSchema.parse(evaluated);
        safety = evaluated;
      }
    } catch {
      safety = { decision: "BLOCK", riskScore: 1, intentMatchScore: 0, reason: "Safety evaluation failed or returned an invalid decision; fail-closed." };
    }
    if (signal?.aborted) safety = { decision: "BLOCK", riskScore: 1, intentMatchScore: 0, reason: "The client cancelled the request before forwarding." };

    let executed = false;
    let response: CallToolResult;
    if (safety.decision === "REQUIRE_APPROVAL" && this.config.review) {
      try {
        const approval = this.approvals.create(params, request, safety);
        safety = { ...safety, approval: { id: approval.id, status: approval.status } };
      } catch {
        safety = { decision: "BLOCK", riskScore: 1, intentMatchScore: 0, reason: "Unable to queue the approval. Nothing was forwarded." };
      }
    }
    if (safety.decision !== "ALLOW") response = deniedResponse(params.name, safety);
    else {
      executed = true;
      try {
        response = await this.executeUpstreamTool(params, signal);
        this.context.observeResult(params.name, response);
      } catch {
        // Never retry a potentially stateful call automatically.
        response = { isError: true, content: [{ type: "text", text: "Upstream MCP call failed or was cancelled after forwarding. Execution outcome may be unknown; the gateway did not retry." }] };
      }
    }
    await this.recordOutcome(request, safety, executed, response);
    return response;
  }

  /** Called only by the authenticated local reviewer, never exposed as an MCP tool. */
  async reviewAction(id: string, fingerprint: string, decision: "approve" | "deny") {
    if (!this.config.review) throw new ApprovalError("Local review is not enabled.", 403);
    if (decision !== "approve" && decision !== "deny") throw new ApprovalError("Unknown review decision.", 400);
    const action = this.approvals.claim(id, fingerprint);
    const { params } = action;
    const request: ToolRequest = { ...action.request, ...this.context.snapshot() };
    const approval = { id, status: decision === "deny" ? "DENIED" : "APPROVED", reviewer: "local-reviewer", reviewedAt: new Date().toISOString() };
    if (decision === "deny") {
      const safety: SafetyResult = { ...action.record.safety, decision: "BLOCK", reason: "The local reviewer denied this exact action.", approval };
      const response = deniedResponse(params.name, safety);
      await this.recordOutcome(request, safety, false, response, "approval_review", false);
      return this.approvals.finish(id, "DENIED", safety.reason, response);
    }
    // Recheck policy and current untrusted evidence at the time of approval.
    // A human review cannot turn a deterministic BLOCK or evaluator error into ALLOW.
    let safety: SafetyResult;
    try {
      const entry = this.catalog.get(params.name);
      if (request.userIntent !== action.request.userIntent || !entry?.validate?.(params.arguments ?? {}).valid) throw new Error("Action changed");
      safety = await this.evaluator(structuredClone(request), this.config.evaluator);
      safetyResultSchema.parse(safety);
    } catch {
      safety = { decision: "BLOCK", riskScore: 1, intentMatchScore: 0, reason: "Safety revalidation failed; approved action was not forwarded." };
    }
    if (!this.approvals.canExecute(id)) {
      safety = { decision: "BLOCK", riskScore: 1, intentMatchScore: 0, reason: "Approval expired or the gateway closed before execution.", approval: { ...approval, status: "EXPIRED" } };
      const response = deniedResponse(params.name, safety);
      await this.recordOutcome(request, safety, false, response, "approval_review");
      return this.approvals.finish(id, "EXPIRED", safety.reason, response);
    }
    if (safety.decision === "BLOCK") {
      safety = { ...safety, approval: { ...approval, status: "BLOCKED" } };
      const response = deniedResponse(params.name, safety);
      await this.recordOutcome(request, safety, false, response, "approval_review");
      return this.approvals.finish(id, "BLOCKED", safety.reason, response);
    }
    safety = { ...safety, decision: "ALLOW", reason: "A local reviewer approved this exact action once, and safety revalidation passed.", approval };
    // Require a saved approval record before dispatching a side-effecting call.
    const authorization = await appendAuditEvent(request, { executed: false, safety, result: { approvalId: id, stage: "authorized" }, cost: { currency: "USD", estimateType: "demo_estimate", decisionUsd: 0, toolUsd: 0, totalUsd: 0 } }, "approval_authorization");
    if (!authorization.logged || !this.approvals.canExecute(id)) {
      const status = authorization.logged ? "EXPIRED" : "BLOCKED";
      safety = { ...safety, decision: "BLOCK", approval: { ...approval, status }, reason: authorization.logged
        ? "Approval expired or the gateway closed before dispatch. Nothing was forwarded."
        : "Could not save the authorization audit record. Nothing was forwarded." };
      const response = deniedResponse(params.name, safety);
      await this.recordOutcome(request, safety, false, response, "approval_review");
      return this.approvals.finish(id, status, safety.reason, response);
    }
    let response: CallToolResult;
    let status: "EXECUTED" | "FAILED";
    try {
      response = await this.executeUpstreamTool(params);
      this.context.observeResult(params.name, response);
      status = response.isError ? "FAILED" : "EXECUTED";
    } catch {
      status = "FAILED";
      response = { isError: true, content: [{ type: "text", text: "Upstream failed after dispatch. Execution outcome may be unknown. No automatic retry was made." }] };
    }
    await this.recordOutcome(request, { ...safety, approval: { ...approval, status } }, true, response, "approval_review");
    return this.approvals.finish(id, status, status === "EXECUTED" ? "Approved action forwarded once and completed successfully." : "Upstream returned an error or disconnected. Inspect the result before submitting another action.", response);
  }

  private async recordOutcome(request: ToolRequest, safety: SafetyResult, executed: boolean, response: CallToolResult, eventType: "tool_call" | "approval_review" = "tool_call", evaluated = true) {
    this.context.record({ timestamp: new Date().toISOString(), toolName: request.toolName, arguments: request.arguments,
      decision: safety.decision, riskScore: safety.riskScore, intentMatchScore: safety.intentMatchScore, executed });
    const cost = estimateCost(request, safety, executed);
    if (!evaluated) { cost.decisionUsd = 0; cost.totalUsd = cost.toolUsd; }
    const audit = await appendAuditEvent(request, executed
      ? { executed: true, result: response, safety, cost }
      : { executed: false, result: response, safety, cost, ...(safety.decision === "REQUIRE_APPROVAL" ? { requiresApproval: true as const } : {}) }, eventType);
    const after = this.context.snapshot().injectionReport;
    console.error([
      "────────────────────────────────────", "MCP TOOL REQUEST", `Intent: ${request.userIntent || "(not set)"}`,
      `Tool: ${request.toolName}`, `Arguments: ${JSON.stringify(request.arguments)}`,
      `Operation: ${request.toolRisk.operation.toUpperCase()}`, `Risk: ${safety.riskScore}`,
      `Intent Match: ${safety.intentMatchScore}`, `Prompt Injection Risk: ${safety.promptInjection?.status === "DETECTED" ? "HIGH (0.95 heuristic)" : "no prior signals"}`,
      `DECISION: ${safety.decision}`, `Reason: ${safety.reason}`, `Evaluator: ${safety.evaluator?.source ?? "LOCAL_VALIDATION"}`,
      ...(safety.evaluator?.requestId ? [`Jev Request ID: ${safety.evaluator.requestId}`] : []),
      `Upstream Executed: ${executed ? "YES (forwarded; inspect result for tool errors)" : "NO"}`,
      ...(executed && after.status === "DETECTED" ? [`Upstream result injection signals: ${after.findings.map(f => f.rule).join(", ")}`] : []),
      `Estimated cost: $${cost.totalUsd.toFixed(6)} (demo estimate)`,
      `Audit: ${audit.logged ? audit.eventId : "FAILED: " + audit.error}`, "────────────────────────────────────",
    ].join("\n"));
  }
}
