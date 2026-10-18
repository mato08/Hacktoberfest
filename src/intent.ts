import type { ToolRequest } from "./types.js";

/** Conservative scope checks for the two demo read tools, not general NLP. */
export function readScopeMismatch(request: ToolRequest, intent: string, unpaid: boolean): string | undefined {
  if (/\b(send|upload|post|transmit|export|credentials?|passwords?|secrets?|tokens?|api keys?)\b|https?:\/\//.test(intent)) {
    return "The original request includes disclosure or an external destination that these customer read tools do not implement.";
  }
  const ids = new Set<number>();
  // Supports customer 1, user #2, customer IDs 1 and 2, and user 1 and user 2.
  for (const match of intent.matchAll(/\b(?:customers?|users?)\s*(?:ids?\s*)?#?\s*(\d+(?:\s*(?:,|and|&)\s*#?\s*\d+)*)\b/g)) {
    for (const id of match[1].match(/\d+/g) ?? []) ids.add(Number(id));
  }
  if (request.toolName === "get_customer") {
    if (unpaid) return "Intent mismatch: the user requested unpaid customers, but get_customer does not enforce the unpaid filter. Use get_unpaid_customers.";
    if (!ids.has(request.arguments.customerId as number)) {
      return "Intent mismatch: the proposed customer ID is not explicitly authorized by the original request.";
    }
  }
  if (request.toolName === "get_unpaid_customers") {
    if (!unpaid) return "Intent mismatch: the original request did not ask for the unpaid-customer list.";
    if (ids.size) return "Intent mismatch: the request names specific customer IDs, but get_unpaid_customers returns the full unpaid list.";
  }
  return undefined;
}
