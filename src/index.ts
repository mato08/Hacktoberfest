import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createGateway } from "./gateway/gatewayServer.js";

export { createGateway };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const gateway = await createGateway(config);
    const stop = () => { void gateway.close().finally(() => { process.exitCode = 0; }); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await gateway.server.connect(new StdioServerTransport());
    console.error(`Intent-aware MCP proxy ready (stdio, ${config.evaluator} evaluator). All logs go to stderr.`);
  } catch (error) {
    console.error(`Gateway startup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
