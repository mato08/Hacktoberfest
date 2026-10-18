import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runScenario } from "./demo-scenarios.mjs";
import { readAuditEvents, reportAuditCosts } from "./dist/audit.js";
import { openDemoSession } from "./gateway-session.mjs";
import { demoDirectory } from "./demo-fixtures.mjs";

const mode = process.argv.includes("--jev") ? "jev" : "local";
const input = createInterface({ input: stdin, output: stdout });
console.log(`\nLIVE MCP SAFETY PROXY — ${mode.toUpperCase()} evaluator\nReal files restricted to ${demoDirectory}`);
try {
  while (true) {
    console.log("\n1  Safe read\n2  Block conflicting write\n3  Prompt injection from a real file\n4  Approval required (no execution)\n5  Discover real upstream tools\n6  Audit / cost totals\nc  Custom intent and normal tool calls\nq  Quit");
    const choice = (await input.question("> ")).trim().toLowerCase();
    if (choice === "q") break;
    try {
      const scenario = { 1: "safe", 2: "block", 3: "injection", 4: "approval" }[choice];
      if (scenario) await runScenario(scenario, { mode });
      else if (choice === "6") console.log(JSON.stringify(reportAuditCosts(await readAuditEvents()), null, 2));
      else if (choice === "5" || choice === "c") {
        const session = await openDemoSession({ mode });
        try {
          const { tools } = await session.client.listTools();
          console.log(tools.map(tool => `${tool.name}: ${tool.description ?? ""}`).join("\n"));
          if (choice === "c") {
            const intent = await input.question("Original user intent (locked for this session): ");
            console.log(await session.client.callTool({ name: "set_user_intent", arguments: { intent } }));
            while (true) {
              const name = (await input.question("Tool name (blank returns to menu): ")).trim();
              if (!name) break;
              const args = JSON.parse(await input.question("Arguments as JSON: "));
              console.log(JSON.stringify(await session.client.callTool({ name, arguments: args }), null, 2));
            }
          }
        } finally { await session.close(); }
      }
    } catch (error) { console.error(`Demo failed: ${error.message}`); }
  }
} finally { input.close(); }
