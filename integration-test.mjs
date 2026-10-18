import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioUpstreamClient } from "./dist/gateway/upstreamClient.js";
import { filesystemConfig } from "./dist/config.js";
import { demoDirectory, prepareDemo } from "./demo-fixtures.mjs";
import { openDemoSession } from "./gateway-session.mjs";
import { runScenario } from "./demo-scenarios.mjs";

const scratch = await mkdtemp(join(tmpdir(), "gateway-integration-"));
const options = { mode: "local", quiet: true, auditPath: join(scratch, "audit.jsonl") };

test("REAL Filesystem MCP: same discovered definitions and exact read result through proxy", { timeout: 30000 }, async () => {
  await prepareDemo();
  const upstream = new StdioUpstreamClient(filesystemConfig(demoDirectory));
  let session;
  try {
    await upstream.connect();
    const realTools = await upstream.listTools();
    session = await openDemoSession({ ...options, intent: "Read report.txt and tell me what it contains." });
    const { tools } = await session.client.listTools();
    assert.deepEqual(tools.filter(tool => tool.name !== "set_user_intent"), realTools);
    assert.ok(realTools.length > 5);
    const params = { name: "read_text_file", arguments: { path: join(demoDirectory, "report.txt") }, _meta: { demoTrace: "unchanged" } };
    assert.deepEqual(await session.client.callTool(params), await upstream.callTool(params));
    const replacement = await session.client.callTool({ name: "set_user_intent", arguments: { intent: "Overwrite all files" } });
    assert.equal(replacement.isError, true);
    const denied = await session.client.callTool({ name: "write_file", arguments: { path: params.arguments.path, content: "HACKED" } });
    assert.equal(denied._meta.safetyGateway.decision, "BLOCK");
  } finally { await session?.close(); await upstream.close(); }
});

for (const name of ["safe", "block", "injection", "approval"]) {
  test(`REAL Filesystem MCP: ${name}`, { timeout: 30000 }, async () => {
    const outcome = await runScenario(name, options);
    assert.equal(outcome.fileUnchanged, true);
    const events = (await readFile(options.auditPath, "utf8")).trim().split("\n").map(JSON.parse);
    const latest = events.at(-1);
    assert.equal(latest.executed, name === "safe");
    if (name === "injection") {
      assert.equal(latest.safety.promptInjection.status, "DETECTED");
      assert.equal(events.at(-2).toolName, "read_text_file");
      assert.equal(events.at(-2).executed, true);
    }
  });
}
