import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

export interface UpstreamServerConfig {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface GatewayConfig {
  upstream: UpstreamServerConfig;
  originalIntent?: string;
  evaluator: "local" | "jev";
  agentId: string;
  workflowId: string;
  review?: { port: number; ttlMs: number };
}

export function filesystemConfig(directory: string): UpstreamServerConfig {
  // Invoke the installed official package with node. No shell quoting or npx download
  // during a presentation; paths with spaces work on Windows, macOS and Linux.
  const require = createRequire(import.meta.url);
  return { command: process.execPath, args: [require.resolve("@modelcontextprotocol/server-filesystem/dist/index.js"), resolve(directory)] };
}

export function loadConfig(): GatewayConfig {
  const command = process.env.UPSTREAM_COMMAND?.trim();
  const args = z.array(z.string()).parse(JSON.parse(process.env.UPSTREAM_ARGS ?? "[]"));
  const env = z.record(z.string(), z.string()).parse(JSON.parse(process.env.UPSTREAM_ENV ?? "{}"));
  const evaluator = z.enum(["local", "jev"]).parse(process.env.SAFETY_EVALUATOR ?? (process.env.JEV_API_KEY ? "jev" : "local"));
  if (evaluator === "jev" && !process.env.JEV_API_KEY) throw new Error("Jev mode requires JEV_API_KEY.");
  if (!command && args.length) throw new Error("UPSTREAM_ARGS requires UPSTREAM_COMMAND.");
  return {
    upstream: command ? { command, args, env, ...(process.env.UPSTREAM_CWD ? { cwd: process.env.UPSTREAM_CWD } : {}) }
      : filesystemConfig(process.env.MCP_DEMO_DIR ?? join(tmpdir(), "intent-safety-mcp-demo")),
    originalIntent: process.env.GATEWAY_ORIGINAL_INTENT?.trim() || undefined,
    evaluator,
    agentId: process.env.GATEWAY_AGENT_ID ?? "demo-agent",
    workflowId: process.env.GATEWAY_WORKFLOW_ID ?? "demo-workflow",
    ...(process.env.REVIEW_PORT ? { review: {
      port: z.coerce.number().int().min(0).max(65535).parse(process.env.REVIEW_PORT),
      ttlMs: z.coerce.number().int().min(1000).max(3_600_000).parse(process.env.REVIEW_TTL_MS ?? "300000"),
    } } : {}),
  };
}
