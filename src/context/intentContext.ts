import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { inspectExternalContent } from "../injection.js";
import type { ActionHistoryItem, ExternalContent, InjectionReport } from "../types.js";

export class IntentContext {
  private intent: string;
  private history: ActionHistoryItem[] = [];
  private excerpts: ExternalContent[] = [];
  private findings: InjectionReport["findings"] = [];
  private sawResult = false;
  private scanIncomplete = false;

  constructor(originalIntent?: string) { this.intent = originalIntent ?? ""; }
  get userIntent() { return this.intent; }

  setUserIntent(intent: string): void {
    if (this.intent && this.intent !== intent) throw new Error("Original intent is locked for this session. Start a new gateway session to change the task.");
    this.intent = intent;
  }

  record(action: ActionHistoryItem) {
    this.history.push(structuredClone(action));
    this.history = this.history.slice(-50);
  }

  snapshot() {
    return structuredClone({
      userIntent: this.intent,
      recentActions: this.history.slice(-10),
      untrustedContext: this.excerpts,
      contextScanIncomplete: this.scanIncomplete,
      injectionReport: {
        status: this.findings.length ? "DETECTED" : this.sawResult ? "NO_SIGNALS" : "NOT_PROVIDED",
        findings: this.findings,
      } as InjectionReport,
    });
  }

  observeResult(toolName: string, result: CallToolResult) {
    this.sawResult = true;
    // Scan text, embedded text resources, and structured data, never execute it.
    // Non-text blobs are passed through unchanged; this MVP does not OCR/decode them.
    const texts = result.content.flatMap(item => {
      if (item.type === "text") return [item.text];
      if (item.type === "resource" && "text" in item.resource) return [String(item.resource.text)];
      return [];
    });
    if (result.structuredContent) texts.push(JSON.stringify(result.structuredContent));
    const combined = texts.join("\n");
    if (combined.length > 256_000) { this.scanIncomplete = true; return; }
    for (let start = 0; start < combined.length; start += 3500) {
      const item = { source: `upstream/${toolName}`.slice(0, 200), content: combined.slice(start, start + 3800) };
      const report = inspectExternalContent([item]);
      if (report.findings.length) {
        this.findings = [...new Map([...this.findings, ...report.findings].map(f => [`${f.source}:${f.rule}`, f])).values()].slice(-50);
        // Keep malicious evidence even when subsequent harmless reads arrive.
        this.excerpts = [item, ...this.excerpts].slice(0, 8);
      } else if (!this.findings.length) {
        this.excerpts = [...this.excerpts, item].slice(-8);
      }
    }
  }
}
