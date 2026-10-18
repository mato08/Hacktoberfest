import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { filesystemConfig } from "./dist/config.js";
import { demoDirectory, prepareDemo } from "./demo-fixtures.mjs";

export async function openDemoSession({ mode = "local", intent, quiet = false, auditPath = "audit/audit-log.jsonl", directory = demoDirectory, reviewPort, reviewTtlMs = 300000 } = {}) {
  if (directory === demoDirectory) await prepareDemo();
  if (mode === "jev" && !process.env.JEV_API_KEY) throw new Error("Jev demo requires JEV_API_KEY in .env.");
  const upstream = filesystemConfig(directory);
  const client = new Client({ name: "gateway-demo-agent", version: "0.2.0" });
  let logs = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./dist/index.js", import.meta.url))],
    env: {
      UPSTREAM_COMMAND: upstream.command, UPSTREAM_ARGS: JSON.stringify(upstream.args),
      SAFETY_EVALUATOR: mode, AUDIT_LOG_PATH: auditPath,
      GATEWAY_AGENT_ID: "presentation-agent", GATEWAY_WORKFLOW_ID: `filesystem-${mode}-demo`,
      ...(reviewPort !== undefined ? { REVIEW_PORT: String(reviewPort), REVIEW_TTL_MS: String(reviewTtlMs) } : {}),
      ...(intent ? { GATEWAY_ORIGINAL_INTENT: intent } : {}),
      ...(mode === "jev" ? { JEV_API_KEY: process.env.JEV_API_KEY, JEV_MODEL: process.env.JEV_MODEL ?? "jev-latest", JEV_TIMEOUT_MS: process.env.JEV_TIMEOUT_MS ?? "20000" } : {}),
    },
    stderr: "pipe",
  });
  transport.stderr.on("data", chunk => { const text = chunk.toString(); logs += text; if (!quiet) process.stderr.write(text); });
  try { await client.connect(transport); }
  catch (error) { await client.close(); throw error; }
  return { client, get logs() { return logs; }, get reviewUrl() { return /Local review dashboard: (http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+)/.exec(logs)?.[1]; }, close: () => client.close() };
}
