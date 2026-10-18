import { isToolName, toolArgumentSchemas, toolPolicies } from "./tools.js";
import { externalContextSchema, hasDestructiveDataInstruction, inspectExternalContent, normalizeSafetyText } from "./injection.js";
import { evaluateWithJev as requestJevDecision, JevError } from "./jev.js";
import { readScopeMismatch } from "./intent.js";
import type { SafetyResult, ToolRequest } from "./types.js";

export async function evaluateToolRequest(request: ToolRequest): Promise<SafetyResult> {
  if (!isToolName(request.toolName)) {
    return { decision: "BLOCK", riskScore: 1, intentMatchScore: 0, reason: "Unknown tools are blocked." };
  }
  if (!request.userIntent.trim()) {
    return { decision: "BLOCK", riskScore: 1, intentMatchScore: 0, reason: "An original user intent is required." };
  }
  const args = toolArgumentSchemas[request.toolName].safeParse(request.arguments);
  if (!args.success) {
    return { decision: "BLOCK", riskScore: 1, intentMatchScore: 0, reason: `Invalid tool arguments: ${args.error.message}` };
  }
  const context = externalContextSchema.safeParse(request.untrustedContext ?? []);
  if (!context.success) {
    return { decision: "BLOCK", riskScore: 1, intentMatchScore: 0, reason: "External content is invalid or exceeds the scan limits; the request was not executed." };
  }
  const promptInjection = inspectExternalContent(context.data);
  const local = evaluateWithLocalRules({ userIntent: request.userIntent, toolName: request.toolName, arguments: request.arguments });
  if (promptInjection.status === "DETECTED") {
    return {
      decision: "BLOCK",
      riskScore: 0.99,
      intentMatchScore: local.intentMatchScore,
      reason: "Possible prompt injection in external content. This request is blocked for review; external text cannot authorize tools or override the user's intent.",
      promptInjection,
      evaluator: { source: "LOCAL_FALLBACK", note: "Blocked by deterministic external-content policy before Jev." },
    };
  }
  if (local.decision === "BLOCK") return { ...local, promptInjection, evaluator: { source: "LOCAL_FALLBACK", note: "Blocked by deterministic safety policy before Jev." } };
  if (!process.env.JEV_API_KEY) return { ...local, promptInjection, evaluator: { source: "LOCAL_FALLBACK", note: "JEV_API_KEY is not configured." } };
  try {
    // External content is state data only; it never becomes part of Jev's instructions.
    const judgment = await requestJevDecision(request, context.data);
    const decision = local.decision === "REQUIRE_APPROVAL" && judgment.decision === "ALLOW"
      ? "REQUIRE_APPROVAL"
      : judgment.decision;
    const reason = local.decision === "REQUIRE_APPROVAL" && judgment.decision === "ALLOW"
      ? "Jev found the action related to the intent, but the local policy requires human approval for this sensitive action."
      : `Jev selected ${judgment.decision} for the proposed action.`;
    return {
      decision,
      riskScore: local.riskScore,
      intentMatchScore: judgment.intentMatchScore,
      reason,
      promptInjection,
      evaluator: judgment.evaluator,
    };
  } catch (error) {
    const message = error instanceof JevError ? error.message : "Jev evaluation failed";
    return {
      decision: "BLOCK", riskScore: 1, intentMatchScore: 0,
      reason: "Jev evaluation was unavailable after a key was configured; blocked rather than executing without the required evaluator.",
      promptInjection,
      evaluator: { source: "JEV_ERROR", note: message },
    };
  }
}

/** Deterministic policy floor used without a key and to constrain real Jev decisions. */
export function evaluateWithLocalRules(request: ToolRequest): SafetyResult {
  if (!isToolName(request.toolName)) {
    return { decision: "BLOCK", riskScore: 1, intentMatchScore: 0, reason: "Unknown tools are blocked." };
  }
  const { operation } = toolPolicies[request.toolName];
  const intent = normalizeSafetyText(request.userIntent).toLowerCase().replaceAll("\u2019", "'");
  if (hasDestructiveDataInstruction(intent)) {
    return { decision: "BLOCK", riskScore: 0.99, intentMatchScore: 0.05, reason: "The request includes database, file, or bulk data destruction, which is outside the scope of these customer tools." };
  }
  const customerContext = /\b(customers?|users?)\b/.test(intent);
  const paymentContext = /\b(payment|payments|refund|refunds|unpaid|billing)\b/.test(intent);
  const readIntent = /\b(find|get|show|list|view|fetch|retrieve|check|look up|give me information|give me details)\b/.test(intent);
  const unpaidIntent = /\b(unpaid|overdue)\b|\b(haven't|have not|hasn't|has not|not) paid\b/.test(intent);
  const deleteIntent = /\b(delete|remove|erase)\b/.test(intent);
  const writeIntent = /\b(delete|remove|erase|drop|truncate|wipe|destroy|purge|clear|nuke|refund|update|modify|change|overwrite|insert|create)\b/.test(intent);
  const negatedAction = /\b(do not|don't|never|must not|cannot|can't|without)\b[^.!?;]*\b(delete|remove|erase|refund|find|get|show|list|view|fetch|retrieve|check)\b/.test(intent);

  if (negatedAction) {
    return { decision: "BLOCK", riskScore: 0.95, intentMatchScore: 0.05, reason: "The intent prohibits an action; this simple evaluator cannot safely authorize it." };
  }
  if (operation === "read" && writeIntent) {
    return { decision: "BLOCK", riskScore: 0.9, intentMatchScore: 0.1, reason: "The intent includes a write or destructive action. This local evaluator cannot safely treat the full request as read-only; request the read separately." };
  }
  if (operation === "delete") {
    if (!customerContext || !deleteIntent) {
      return { decision: "BLOCK", riskScore: 0.95, intentMatchScore: 0.08, reason: "The user did not explicitly request customer deletion; this destructive operation does not match the intent." };
    }
    return { decision: "REQUIRE_APPROVAL", riskScore: 0.95, intentMatchScore: 0.9, reason: "Customer deletion was requested, but destructive actions require human approval." };
  }
  if (operation === "financial_write") {
    if (!customerContext && !paymentContext) {
      return { decision: "BLOCK", riskScore: 0.85, intentMatchScore: 0.05, reason: "A customer refund is unrelated to the user's intent." };
    }
    return { decision: "REQUIRE_APPROVAL", riskScore: 0.85, intentMatchScore: paymentContext ? 0.75 : 0.4, reason: "A refund may relate to the request, but changes financial data and requires human approval." };
  }
  const mismatch = readScopeMismatch(request, intent, unpaidIntent);
  if (mismatch) return { decision: "BLOCK", riskScore: 0.8, intentMatchScore: 0.05, reason: mismatch };
  if (customerContext && readIntent && (request.toolName !== "get_unpaid_customers" || unpaidIntent)) {
    return { decision: "ALLOW", riskScore: 0.1, intentMatchScore: 0.96, reason: "The requested read operation matches the user's customer information request." };
  }
  return { decision: "BLOCK", riskScore: 0.1, intentMatchScore: 0.1, reason: "The requested read operation does not clearly match the user's intent." };
}
