import { basename } from "node:path";
import type { ToolRequest } from "./types.js";
import { words } from "./riskClassifier.js";

export const actionPatterns = {
  read: /\b(read|summari[sz]e|analy[sz]e|inspect|find|get|show|list|view|fetch|retrieve|check|search|look|information|details|tell me|review)\b/,
  write: /\b(write|update|edit|create|move|rename|modify|change|overwrite|append|insert|organize|organise|save|set)\b/,
  delete: /\b(delete|remove|erase|drop|truncate|wipe|destroy|purge|clear|nuke)\b/,
  financial: /\b(refund|pay|charge|purchase|buy|transfer|withdraw)\b/,
  external_send: /\b(send|upload|post|publish|email|transmit|share|export)\b/,
};

export function parseIntent(intent: string) {
  const text = words(intent).replaceAll("’", "'");
  const forbidden = [...text.matchAll(/\b(?:do not|don't|never|must not|cannot|can't|without|no)\b[^.!?;]*/g)].map(match => match[0]);
  const positive = text.replace(/\b(?:do not|don't|never|must not|cannot|can't|without|no)\b[^.!?;]*/g, "");
  return { text, positive, forbidden, readOnly: /\bread only\b/.test(text) || forbidden.some(part => actionPatterns.write.test(part)) };
}

/** Reuses the MVP's explicit-target/filter constraint, independent of tool names. */
export function readScopeMismatch(request: ToolRequest): string | undefined {
  const { text: intent } = parseIntent(request.userIntent);
  const metadata = words(request.toolMetadata.name);
  if (/\b(unpaid|overdue)\b|\b(haven't|have not|hasn't|has not|not) paid\b/.test(intent)
      && /\b(customer|customers|user|users)\b/.test(metadata)
      && !/\b(unpaid|overdue)\b/.test(metadata)
      && request.arguments.unpaid !== true && request.arguments.status !== "unpaid") {
    return "The user requested unpaid customers, but this tool call does not enforce that filter.";
  }
  const ids = [...intent.matchAll(/\b(?:customers?|users?)\s*(?:ids?\s*)?#?\s*(\d+(?:\s*(?:,|and|&)\s*#?\s*\d+)*)\b/g)].flatMap(match => match[1].match(/\d+/g) ?? []);
  for (const [key, value] of Object.entries(request.arguments)) {
    if (/^(customer|user)_?id$/i.test(key) && (!ids.length || !ids.includes(String(value)))) return "The proposed record ID is not explicitly included in the original intent.";
  }
  if (ids.length && /\b(list|all|unpaid)\b/.test(metadata) && !Object.keys(request.arguments).some(key => /id/i.test(key))) {
    return "The intent names specific records but this call would retrieve a broader list.";
  }
  const filenames = [...request.userIntent.matchAll(/(?:[\w-]+\.)+[a-zA-Z0-9]{1,10}\b/g)].map(match => match[0].toLowerCase());
  if (filenames.length && request.toolRisk.operation === "read") {
    for (const [key, raw] of Object.entries(request.arguments)) {
      if (!/^(paths?|files?|filename)$/i.test(key)) continue;
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        if (typeof value === "string" && !filenames.includes(basename(value.replaceAll("\\", "/")).toLowerCase())) {
          return "The requested file is outside the explicitly named files in the original intent.";
        }
      }
    }
  }
  return undefined;
}

export function hasTaskOverlap(request: ToolRequest): boolean {
  const intent = words(request.userIntent);
  const metadata = words(`${request.toolMetadata.name} ${request.toolMetadata.description ?? ""}`);
  if (/\b(file|files|folder|folders|directory|directories|filesystem|report|document)\b|\w+\.(?:txt|md|csv|json|pdf)\b/.test(intent)
      && /\b(file|files|folder|folders|directory|directories|filesystem)\b/.test(metadata)) return true;
  const stop = new Set("read reads get gets list lists search find fetch show tell information details please with from about this that these those their then only have what contents content summarize summary analyze help give user requested request tool tools function returns return data all for the and are can".split(" "));
  const tokens = (text: string) => (text.match(/[a-z]{3,}/g) ?? []).map(word => word.replace(/s$/, "")).filter(word => !stop.has(word));
  const task = new Set(tokens(intent));
  return tokens(metadata).some(token => task.has(token));
}
