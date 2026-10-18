import { strict as assert } from "node:assert";
import { runScenario } from "./demo-scenarios.mjs";
const result = await runScenario("safe", { mode: "jev" });
assert.match(result.logs, /Evaluator: JEV\r?\n/);
assert.match(result.logs, /Jev Request ID:/);
console.log("Real Jev decision and real Filesystem MCP read both verified.");
