import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type SafetyDecision = "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL";
export interface ToolRiskMetadata {
  riskLevel: "low" | "medium" | "high" | "critical";
  operation: "read" | "write" | "delete" | "financial" | "external_send" | "unknown";
  reason: string;
}
export interface ActionHistoryItem {
  timestamp: string;
  toolName: string;
  arguments: Record<string, unknown>;
  decision: SafetyDecision;
  intentMatchScore: number;
  riskScore: number;
  executed: boolean;
}

export interface ExternalContent {
  source: string;
  content: string;
}

export interface InjectionReport {
  status: "NOT_PROVIDED" | "NO_SIGNALS" | "DETECTED";
  findings: { source: string; rule: string }[];
}

export interface EvaluatorInfo {
  source: "JEV" | "LOCAL_FALLBACK" | "JEV_ERROR";
  model?: string;
  requestId?: string;
  confidence?: number;
  latencyMs?: number;
  note?: string;
}

export interface CostEstimate {
  currency: "USD";
  estimateType: "demo_estimate";
  decisionUsd: number;
  toolUsd: number;
  totalUsd: number;
}

export interface AuditInfo {
  eventId: string;
  logged: boolean;
  logPath: string;
  error?: string;
}

export interface SafetyResult {
  decision: SafetyDecision;
  riskScore: number;
  intentMatchScore: number;
  reason: string;
  promptInjection?: InjectionReport;
  evaluator?: EvaluatorInfo;
  approval?: { id: string; status: string; reviewer?: string; reviewedAt?: string };
}

export interface ToolRequest {
  userIntent: string;
  toolName: string;
  arguments: Record<string, unknown>;
  untrustedContext?: ExternalContent[];
  toolMetadata: Tool;
  toolRisk: ToolRiskMetadata;
  recentActions?: ActionHistoryItem[];
  injectionReport?: InjectionReport;
  contextScanIncomplete?: boolean;
  /** Caller labels make the audit report useful across many agents and workflows. */
  agentId?: string;
  workflowId?: string;
}

export type AuditedOutcome =
  | { executed: true; safety: SafetyResult; result: unknown; cost: CostEstimate; audit: AuditInfo }
  | { executed: false; safety: SafetyResult; requiresApproval?: true; cost: CostEstimate; audit: AuditInfo };

export type ExecutionResult = AuditedOutcome;
