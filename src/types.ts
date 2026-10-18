export type SafetyDecision = "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL";

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
}

export interface ToolRequest {
  userIntent: string;
  toolName: string;
  arguments: Record<string, unknown>;
  untrustedContext?: ExternalContent[];
  /** Caller labels make the audit report useful across many agents and workflows. */
  agentId?: string;
  workflowId?: string;
}

export type AuditedOutcome =
  | { executed: true; safety: SafetyResult; result: unknown; cost: CostEstimate; audit: AuditInfo }
  | { executed: false; safety: SafetyResult; requiresApproval?: true; cost: CostEstimate; audit: AuditInfo };

export type ExecutionResult = AuditedOutcome;
