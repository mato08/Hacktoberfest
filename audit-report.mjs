import { auditLogPath, readAuditEvents, reportAuditCosts } from "./dist/audit.js";

const money = (value) => `$${value.toFixed(4)}`;
const printGroup = (title, entries) => {
  console.log(`\n${title}`);
  console.log("Name                              Calls  Run  Block  Review  Estimate");
  for (const entry of entries) {
    console.log(`${entry.name.slice(0, 32).padEnd(33)} ${String(entry.calls).padStart(5)} ${String(entry.executed).padStart(4)} ${String(entry.blocked).padStart(6)} ${String(entry.approvals).padStart(7)} ${money(entry.estimatedUsd).padStart(9)}`);
  }
};

const events = await readAuditEvents();
const report = reportAuditCosts(events);
console.log(`Audit log: ${auditLogPath()}`);
console.log(`Calls recorded: ${report.calls}`);
console.log(`Estimated cost: ${money(report.estimatedUsd)} (demo estimate, not an invoice)`);
if (events.length) {
  printGroup("By agent", report.byAgent);
  printGroup("By workflow", report.byWorkflow);
  printGroup("By MCP tool", report.byTool);
  console.log("\nMost recent audit event:");
  console.log(JSON.stringify(events.at(-1), null, 2));
} else {
  console.log("No calls recorded yet. Run npm run live-demo, choose a scenario, then rerun this command.");
}
