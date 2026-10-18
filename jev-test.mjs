import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.env.JEV_API_KEY) {
  console.error("JEV_API_KEY is not set. Create a Jev API key, set it in this terminal, then rerun npm run jev-test.");
  process.exitCode = 2;
} else {
  const client = new Client({ name: "intent-safety-jev-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./dist/index.js", import.meta.url))],
    // The SDK intentionally inherits only a safe allowlist of environment
    // variables. Forward Jev's configuration explicitly to the MCP child.
    env: {
      JEV_API_KEY: process.env.JEV_API_KEY,
      ...(process.env.JEV_MODEL ? { JEV_MODEL: process.env.JEV_MODEL } : {}),
    },
    stderr: "inherit",
  });
  try {
    await client.connect(transport);
    const cases = [
      {
        label: "Matching read request",
        request: { userIntent: "Find customers who haven't paid this month.", toolName: "get_unpaid_customers", arguments: {} },
        expected: "ALLOW",
      },
      {
        label: "Specific customer lookup",
        request: { userIntent: "Get customer 1's account details.", toolName: "get_customer", arguments: { customerId: 1 } },
        expected: "ALLOW",
      },
    ];
    for (const { label, request, expected } of cases) {
      const response = await client.callTool({ name: "safe_execute", arguments: request });
      assert.equal(response.isError, undefined);
      const result = response.structuredContent;
      console.log(`\n${label}\n${JSON.stringify(result, null, 2)}`);
      assert.equal(result.safety.evaluator?.source, "JEV", "Expected a real Jev decision, not fallback");
      assert.equal(result.safety.decision, expected);
      assert.equal(result.executed, expected === "ALLOW");
      assert.equal(typeof result.safety.evaluator.requestId, "string");
    }
    console.log("\nJev integration test passed.");
  } finally {
    await client.close();
  }
}
