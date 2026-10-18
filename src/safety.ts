import { z } from "zod";
import { externalContextSchema, inspectExternalContent } from "./injection.js";
import { evaluateWithJev as requestJevDecision, JevError } from "./jev.js";
import { actionPatterns, hasTaskOverlap, parseIntent, readScopeMismatch } from "./intent.js";
import type { SafetyResult, ToolRequest } from "./types.js";

export const safetyResultSchema = z.object({
  decision: z.enum(["ALLOW", "BLOCK", "REQUIRE_APPROVAL"]),
  riskScore: z.number().finite().min(0).max(1),
  intentMatchScore: z.number().finite().min(0).max(1),
  reason: z.string().min(1),
}).passthrough();

export async function evaluateToolRequest(request: ToolRequest, mode: "local" | "jev" = process.env.JEV_API_KEY ? "jev" : "local"): Promise<SafetyResult> {
  const context = externalContextSchema.safeParse(request.untrustedContext ?? []);
  if (!context.success || request.contextScanIncomplete) return { decision: "BLOCK", riskScore: 1, intentMatchScore: 0, reason: "Untrusted result exceeded the supported scan limits; restart with a smaller result or a reviewed policy." };
  const promptInjection = request.injectionReport ?? inspectExternalContent(context.data);
  const local = evaluateWithLocalRules(request);
  const result = { ...local, promptInjection, evaluator: { source: "LOCAL_FALLBACK" as const, note: "Deterministic intent and operation policy." } };
  if (local.decision === "BLOCK") return result;
  if (promptInjection.status === "DETECTED" && request.toolRisk.operation !== "read") {
    return { ...result, decision: "BLOCK", riskScore: 0.99, reason: "A state-changing action followed suspicious upstream instructions. External results cannot authorize a change." };
  }
  if (mode === "local") return result;
  try {
    const judgment = await requestJevDecision(request, context.data);
    const decision = judgment.decision === "ALLOW" && local.decision === "REQUIRE_APPROVAL" ? "REQUIRE_APPROVAL" : judgment.decision;
    if (judgment.decision === "ALLOW" && judgment.intentMatchScore < 0.7) {
      return { ...result, decision: "BLOCK", intentMatchScore: judgment.intentMatchScore, reason: "Jev's intent match was below the minimum 70%; action withheld.", evaluator: judgment.evaluator };
    }
    return { ...result, decision, intentMatchScore: judgment.intentMatchScore, evaluator: judgment.evaluator,
      reason: decision === "REQUIRE_APPROVAL" && judgment.decision === "ALLOW" ? local.reason : `Jev selected ${judgment.decision} after comparing the original intent, proposed action, metadata and recent history. ${local.reason}` };
  } catch (error) {
    return { ...result, decision: "BLOCK", riskScore: 1, intentMatchScore: 0,
      reason: "Required Jev evaluation failed; the call was not forwarded.",
      evaluator: { source: "JEV_ERROR", note: error instanceof JevError ? error.message : "Jev evaluation failed" } };
  }
}

export function evaluateWithLocalRules(request: ToolRequest): SafetyResult {
  const { operation, riskLevel } = request.toolRisk;
  const riskScore = { low: 0.1, medium: 0.45, high: 0.83, critical: 0.99 }[riskLevel];
  const block = (reason: string): SafetyResult => ({ decision: "BLOCK", riskScore, intentMatchScore: 0.08, reason });
  if (!request.userIntent.trim()) return block("Set the original user intent before calling upstream tools.");
  if (operation === "unknown") return block("The operation is unknown or can execute arbitrary code/queries; no generic safe authorization is available.");
  const intent = parseIntent(request.userIntent);
  if (intent.forbidden.some(part => actionPatterns[operation].test(part)) || (intent.readOnly && operation !== "read")) {
    return block("The original user intent prohibits this operation; read-only analysis cannot authorize a state change.");
  }
  if (operation === "read") {
    const mismatch = readScopeMismatch(request);
    if (mismatch) return block(mismatch);
    if (!actionPatterns.read.test(intent.positive) || !hasTaskOverlap(request)) return block("The requested read does not clearly belong to the user's original task.");
    return { decision: "ALLOW", riskScore, intentMatchScore: 0.96, reason: "The read operation and its targets match the original information request." };
  }
  if (!actionPatterns[operation].test(intent.positive) || !hasTaskOverlap(request)) {
    return block("The user did not request this kind of side effect. The proposed action conflicts with the original intent.");
  }
  return { decision: "REQUIRE_APPROVAL", riskScore, intentMatchScore: 0.85, reason: "The action may fit the task but changes state, discloses data, or affects money. Human approval is required; it has not executed." };
}
