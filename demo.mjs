import { runScenario } from "./demo-scenarios.mjs";
import { demoDirectory } from "./demo-fixtures.mjs";
const mode = process.argv.includes("--jev") ? "jev" : "local";
console.log(`MCP Safety Gateway — REAL filesystem demo (${mode} evaluator)\nIsolated directory: ${demoDirectory}`);
for (const name of ["safe", "block", "injection", "approval"]) await runScenario(name, { mode });
console.log("\nAll real MCP demo scenarios passed. Run npm run audit-report for call and cost totals.");
