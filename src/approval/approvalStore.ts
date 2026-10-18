import { createHash, randomUUID } from "node:crypto";
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SafetyResult, ToolRequest } from "../types.js";

export type ApprovalStatus = "PENDING" | "REVIEWING" | "EXECUTED" | "DENIED" | "EXPIRED" | "BLOCKED" | "FAILED";
export interface ApprovalRecord {
  id: string;
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
  reviewedAt?: string;
  status: ApprovalStatus;
  toolName: string;
  arguments: Record<string, unknown>;
  userIntent: string;
  agentId?: string;
  workflowId?: string;
  safety: SafetyResult;
  result?: CallToolResult;
  note?: string;
}
interface StoredAction { record: ApprovalRecord; params: CallToolRequest["params"]; request: ToolRequest }

export class ApprovalError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}

/** Per-process approvals. No authorization survives a gateway restart. */
export class ApprovalStore {
  private readonly actions = new Map<string, StoredAction>();
  private closed = false;
  constructor(private readonly ttlMs = 300_000, private readonly now = () => Date.now()) {}

  private expire() {
    for (const { record } of this.actions.values()) {
      if (record.status === "PENDING" && Date.parse(record.expiresAt) <= this.now()) {
        record.status = "EXPIRED";
        record.note = "Approval expired. Nothing was forwarded. Submit a new tool request for a new review.";
      }
    }
  }

  create(params: CallToolRequest["params"], request: ToolRequest, safety: SafetyResult): ApprovalRecord {
    if (this.closed) throw new ApprovalError("Gateway session is closed.");
    if (safety.decision !== "REQUIRE_APPROVAL") throw new ApprovalError("Only reviewable actions can enter the approval queue.");
    this.expire();
    const fingerprint = createHash("sha256").update(JSON.stringify({ params, intent: request.userIntent })).digest("hex");
    const existing = [...this.actions.values()].find(action => action.record.fingerprint === fingerprint && action.record.status === "PENDING");
    if (existing) return structuredClone(existing.record);
    if (this.actions.size >= 200) {
      const completed = [...this.actions].find(([, action]) => !["PENDING", "REVIEWING"].includes(action.record.status));
      if (!completed) throw new ApprovalError("Review queue is full. Finish existing reviews first.");
      this.actions.delete(completed[0]);
    }
    const record: ApprovalRecord = {
      id: randomUUID(), fingerprint, createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      status: "PENDING", toolName: params.name, arguments: structuredClone(request.arguments), userIntent: request.userIntent,
      agentId: request.agentId, workflowId: request.workflowId, safety: structuredClone(safety),
    };
    this.actions.set(record.id, { record, params: structuredClone(params), request: structuredClone(request) });
    return structuredClone(record);
  }

  list(): ApprovalRecord[] { this.expire(); return structuredClone([...this.actions.values()].map(action => action.record).reverse()); }
  get(id: string): ApprovalRecord {
    this.expire();
    const action = this.actions.get(id);
    if (!action) throw new ApprovalError("Approval not found in this gateway session.", 404);
    return structuredClone(action.record);
  }

  claim(id: string, fingerprint: string): StoredAction {
    if (this.closed) throw new ApprovalError("Gateway session is closed.");
    const record = this.get(id);
    if (record.fingerprint !== fingerprint) throw new ApprovalError("The reviewed action does not match the stored action.");
    if (record.status !== "PENDING") throw new ApprovalError(`This action is ${record.status.toLowerCase()} and cannot be reviewed again.`);
    const stored = this.actions.get(id)!;
    // Synchronous consumption before any await prevents double-click/replay races.
    stored.record.status = "REVIEWING";
    stored.record.reviewedAt = new Date(this.now()).toISOString();
    return structuredClone(stored);
  }

  canExecute(id: string): boolean {
    const record = this.actions.get(id)?.record;
    return !this.closed && record?.status === "REVIEWING" && Date.parse(record.expiresAt) > this.now();
  }

  finish(id: string, status: Exclude<ApprovalStatus, "PENDING" | "REVIEWING">, note: string, result?: CallToolResult): ApprovalRecord {
    const action = this.actions.get(id);
    if (!action) throw new ApprovalError("Approval not found.", 404);
    action.record.status = status;
    action.record.note = note;
    action.record.result = result && structuredClone(result);
    return structuredClone(action.record);
  }

  close() {
    this.closed = true;
    for (const { record } of this.actions.values()) {
      if (record.status === "PENDING") { record.status = "EXPIRED"; record.note = "Gateway session closed before review."; }
    }
  }
}
