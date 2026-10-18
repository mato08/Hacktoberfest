import { strict as assert } from "node:assert";
import { join } from "node:path";
import { filesystemConfig } from "./dist/config.js";
import { StdioUpstreamClient } from "./dist/gateway/upstreamClient.js";
import { prepareDemo, reportText } from "./demo-fixtures.mjs";

const directory = await prepareDemo();
const upstream = new StdioUpstreamClient(filesystemConfig(directory));
try {
  await upstream.connect();
  console.log("Connected to REAL official Filesystem MCP server.");
  const tools = await upstream.listTools();
  console.log("Discovered dynamically:\n" + tools.map(tool => `  ${tool.name}`).join("\n"));
  assert.ok(tools.some(tool => tool.name === "read_text_file"));
  const result = await upstream.callTool({ name: "read_text_file", arguments: { path: join(directory, "report.txt") } });
  assert.ok(!result.isError);
  assert.equal(result.content[0].text, reportText);
  console.log("Real read (direct connection, before interception):\n" + result.content[0].text);
} finally { await upstream.close(); }
