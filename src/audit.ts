import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isToolName } from "./tools.js";
import type { AuditInfo, CostEstimate, ExecutionResult, ToolRequest } from "./types.js";

export interface AuditEvent {
  id: string;
  timestamp: string;
  agentId: string;
  workflowId: string;
  userIntent: string;
  toolName: string;
  arguments: Record<string, unknown>;
  decision: string;
  executed: boolean;
  requiresApproval: boolean;
  result: unknown;
  safety: ExecutionResult["safety"];
  cost: CostEstimate;
}

const toolExecutionEstimates: Record<string, number> = {
  get_unpaid_customers: 0.0005,
  get_customer: 0.00025,
  delete_customer: 0.003,
  refund_customer: 0.005,
};

export function auditLogPath() {
  return resolve(process.env.AUDIT_LOG_PATH ?? "audit/audit-log.jsonl");
}

/** Transparent, configurable demo estimates; these are not a provider invoice. */
export function estimateCost(request: ToolRequest, safety: ExecutionResult["safety"], executed: boolean): CostEstimate {
  const decisionUsd = safety.evaluator?.source === "JEV" ? 0.0015 : 0.0001;
  const toolUsd = executed && isToolName(request.toolName) ? toolExecutionEstimates[request.toolName] : 0;
  return {
    currency: "USD",
    estimateType: "demo_estimate",
    decisionUsd,
    toolUsd,
    totalUsd: Number((decisionUsd + toolUsd).toFixed(6)),
  };
}

type AuditOutcome =
  | { executed: true; safety: ExecutionResult["safety"]; result: unknown; cost: CostEstimate }
  | { executed: false; safety: ExecutionResult["safety"]; requiresApproval?: true; cost: CostEstimate };

export async function appendAuditEvent(request: ToolRequest, response: AuditOutcome): Promise<AuditInfo> {
  const logPath = auditLogPath();
  const event: AuditEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    agentId: request.agentId ?? "unlabeled-agent",
    workflowId: request.workflowId ?? "unlabeled-workflow",
    userIntent: request.userIntent,
    toolName: request.toolName,
    arguments: request.arguments,
    decision: response.safety.decision,
    executed: response.executed,
    requiresApproval: "requiresApproval" in response && response.requiresApproval === true,
    result: response.executed ? response.result : null,
    safety: response.safety,
    cost: response.cost,
  };
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(event)}\n`, "utf8");
    return { eventId: event.id, logged: true, logPath };
  } catch (error) {
    return { eventId: event.id, logged: false, logPath, error: error instanceof Error ? error.message : "Audit log write failed" };
  }
}

export async function readAuditEvents(): Promise<AuditEvent[]> {
  try {
    const file = await readFile(auditLogPath(), "utf8");
    return file.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as AuditEvent]; } catch { return []; }
    });
  } catch (error: unknown) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export function reportAuditCosts(events: AuditEvent[]) {
  const group = (key: keyof Pick<AuditEvent, "agentId" | "workflowId" | "toolName">) => Object.entries(events.reduce<Record<string, { calls: number; executed: number; blocked: number; approvals: number; estimatedUsd: number }>>((totals, event) => {
    const name = event[key];
    const current = totals[name] ?? { calls: 0, executed: 0, blocked: 0, approvals: 0, estimatedUsd: 0 };
    current.calls++;
    current.executed += Number(event.executed);
    current.blocked += Number(event.decision === "BLOCK");
    current.approvals += Number(event.decision === "REQUIRE_APPROVAL");
    current.estimatedUsd = Number((current.estimatedUsd + event.cost.totalUsd).toFixed(6));
    totals[name] = current;
    return totals;
  }, {})).map(([name, totals]) => ({ name, ...totals }));
  return {
    calls: events.length,
    estimatedUsd: Number(events.reduce((sum, event) => sum + event.cost.totalUsd, 0).toFixed(6)),
    byAgent: group("agentId"),
    byWorkflow: group("workflowId"),
    byTool: group("toolName"),
  };
}
