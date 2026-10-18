import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRiskMetadata } from "./types.js";
import { normalizeSafetyText } from "./injection.js";

export function words(text: string): string {
  return normalizeSafetyText(text.replace(/([a-z])([A-Z])/g, "$1 $2")).toLowerCase().replace(/[_-]/g, " ");
}

/** Conservative operation inference. Metadata/annotations are hints, never authorization. */
export function classifyToolRisk(tool: Tool): ToolRiskMetadata {
  const name = words(tool.name);
  const description = words(tool.description ?? "").replace(/\b(?:does not|do not|without|never)\b[^.!?;]*/g, "");
  const schema = words(JSON.stringify(tool.inputSchema));
  const text = `${name} ${description}`;
  const risk = (operation: ToolRiskMetadata["operation"], riskLevel: ToolRiskMetadata["riskLevel"], reason: string): ToolRiskMetadata => ({ operation, riskLevel, reason });
  if (/\b(sql|shell|script|command|eval|execute|exec|terminal)\b/.test(name + " " + schema)) {
    return risk("unknown", "critical", "Arbitrary query/code execution can hide multiple operations; requires a dedicated policy.");
  }
  if (/\b(delete|deletes|deleting|remove|removes|drop|truncate|wipe|erase|purge|destroy)\b/.test(text)) {
    return risk("delete", "critical", "Name or description indicates destructive data removal.");
  }
  if (/\b(refund|refunds|charge|charges|purchase|pay|payment|transfer funds|withdraw)\b/.test(name)
      || /\b(issue|process|execute|initiate)\s+(?:a\s+)?(?:refund|payment|charge|transfer)\b/.test(description)) {
    return risk("financial", "high", "Metadata indicates a financial side effect.");
  }
  if (/\b(send|sends|publish|publishes|upload|post|email|transmit|dispatch)\b/.test(text)
      || (/\b(recipient|webhook|destination url)\b/.test(schema) && !/\b(read|get|list|search)\b/.test(name))) {
    return risk("external_send", "high", "Metadata indicates transmission or publication to another destination.");
  }
  if (/\b(write|writes|writing|overwrite|overwrites|update|updates|edit|edits|create|creates|move|moves|rename|modify|modifies|append|set|insert)\b/.test(text)) {
    return risk("write", "high", "Name or description indicates modification of external state.");
  }
  if (/\b(content|edits|new value|replacement|destination)\b/.test(words(Object.keys(tool.inputSchema.properties ?? {}).join(" ")))
      && !/\b(read|get|list|search|find|fetch)\b/.test(name)) {
    return risk("unknown", "high", "Input schema suggests writable data but the operation is unclear.");
  }
  if (/\b(read|reads|get|gets|list|lists|search|searches|find|fetch|retrieve|view|inspect)\b/.test(text)) {
    return risk("read", "low", "Name and description indicate information retrieval with no detected write capability.");
  }
  return risk("unknown", "high", "Insufficient operation evidence; unknown tools are not automatically safe.");
}
