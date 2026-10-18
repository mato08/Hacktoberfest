import { z } from "zod";
import type { ExternalContent, InjectionReport } from "./types.js";

// Bound scanning work; reject oversized inputs instead of silently truncating them.
export const externalContextSchema = z.array(z.strictObject({
  source: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(4000),
})).max(8);

export function normalizeSafetyText(text: string): string {
  return text.normalize("NFKC")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "")
    .replace(/[^\S\n]+/g, " ");
}

// Database/file/bulk destruction is outside every tool's supported scope.
// Reuse this check for both external content and the original intent.
const destructiveDataPattern = /\b(?:delete|drop|truncate|wipe|destroy|purge|erase|remove|clear|nuke)\b.{0,120}\b(?:databases?|db|data|tables?|records?|rows?|files?|backups?|everything)\b|\bdelete\s+from\b/i;

export function hasDestructiveDataInstruction(text: string): boolean {
  return destructiveDataPattern.test(normalizeSafetyText(text).replace(/\s+/g, " "));
}

const signals: { rule: string; pattern: RegExp }[] = [
  {
    rule: "Destructive data operation instruction",
    pattern: destructiveDataPattern,
  },
  {
    rule: "Instruction override",
    pattern: /\b(ignore|disregard|override|forget)\b.{0,80}\b(instructions?|rules?|prompts?|polic(?:y|ies))\b/i,
  },
  {
    rule: "System or developer role impersonation",
    pattern: /(?:^|\n)\s*(?:#{1,6}\s*)?(?:system|developer)\s*(?:message\s*)?:|<\/?(?:system|developer)>|\[\s*(?:system|inst)\s*\]|<\|(?:im_start|start_header_id)\|>\s*(?:system|developer)/i,
  },
  {
    rule: "Approval or safety bypass claim",
    pattern: /\b(?:user|human|admin(?:istrator)?)\s+(?:has\s+)?(?:already\s+)?(?:approved|authorized)\b|\b(?:skip|bypass|disable)\b.{0,60}\b(?:approval|safety|security|guardrails?)\b|\b(?:no|without)\s+(?:human\s+)?approval\b/i,
  },
  {
    rule: "Embedded tool execution instruction",
    pattern: /\b(?:call|invoke|execute|run|use)\b.{0,80}\b(?:safe_execute|get_unpaid_customers|get_customer|delete_customer|refund_customer)\b|\b(?:delete|erase|remove|refund)\s+(?:all\s+|the\s+)?customers?\b/i,
  },
  {
    rule: "Secret disclosure or data exfiltration instruction",
    pattern: /\b(?:send|upload|post|leak|reveal|print|exfiltrate)\b.{0,120}\b(?:api[ _-]?keys?|secrets?|passwords?|tokens?|credentials?|system prompt)\b|\b(?:send|upload|post|exfiltrate)\b.{0,120}\b(?:customer|billing|payment)\s+(?:data|records?|list)\b/i,
  },
];

/** Signals only: absence of a match is not proof of safety. No instructions are executed. */
export function inspectExternalContent(context: ExternalContent[] = []): InjectionReport {
  const validated = externalContextSchema.parse(context);
  const findings: InjectionReport["findings"] = [];
  for (const item of validated) {
    // Catch simple full-width and zero-width obfuscation, not arbitrary encodings.
    const text = normalizeSafetyText(`${item.source}\n${item.content}`);
    for (const { rule, pattern } of signals) {
      // Preserve role-line boundaries, but also scan wrapped instructions as one line.
      if (pattern.test(text) || pattern.test(text.replace(/\s+/g, " "))) {
        findings.push({ source: item.source, rule });
      }
    }
  }
  return {
    status: findings.length ? "DETECTED" : validated.length ? "NO_SIGNALS" : "NOT_PROVIDED",
    findings,
  };
}
