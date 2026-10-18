import { mkdtemp, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDemoSession } from "./gateway-session.mjs";

const directory = await mkdtemp(join(tmpdir(), "mcp-approval-demo-"));
await writeFile(join(directory, "readme.txt"), "Human review demo: write requests wait for your decision.\n", { flag: "wx" });
const content = "Reviewed by a human.\n";
const session = await openDemoSession({
  mode: process.argv.includes("--jev") ? "jev" : "local", directory, reviewPort: 0,
  intent: "Read readme.txt and create approved-note.txt and denied-note.txt with the text Reviewed by a human. Do not delete files or send data.",
});
const pending = [];
try {
  const read = await session.client.callTool({ name: "read_text_file", arguments: { path: join(directory, "readme.txt") } });
  if (read.isError) throw new Error("Demo read was blocked. See the safety decision above.");
  for (const filename of ["denied-note.txt", "approved-note.txt"]) {
    const result = await session.client.callTool({ name: "write_file", arguments: { path: join(directory, filename), content } });
    const approval = result._meta?.safetyGateway?.approval;
    if (!approval) throw new Error(`No approval queued for ${filename}. See the safety decision above.`);
    try { await access(join(directory, filename)); throw new Error("Unexpected file write before approval."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    pending.push({ id: approval.id, filename });
  }
  console.log(`\nREAL HUMAN REVIEW DEMO\n\nFolder: ${directory}\nDashboard: ${session.reviewUrl}\n\n1. Approve approved-note.txt in the browser.\n2. Deny denied-note.txt.\n3. Open Activity to inspect the actual MCP result.\n\nNeither file exists yet. The agent has no tool to approve its own actions.\nKeep this terminal open. Ctrl+C ends the gateway session.\n`);
  let polling = false;
  const timer = setInterval(async () => {
    if (polling || !pending.length) return;
    polling = true;
    try {
      for (const item of [...pending]) {
        const response = await session.client.callTool({ name: "get_approval_status", arguments: { id: item.id } });
        const status = JSON.parse(response.content[0].text);
        if (["PENDING", "REVIEWING"].includes(status.status)) continue;
        pending.splice(pending.indexOf(item), 1);
        if (status.status === "EXECUTED") {
          const actual = await readFile(join(directory, item.filename), "utf8");
          if (actual !== content) throw new Error("Written file did not match the approved text.");
          console.log(`VERIFIED ON DISK: ${item.filename} contains exactly the approved text.`);
        } else {
          try { await access(join(directory, item.filename)); console.log(`Inspect ${item.filename}: a file exists after ${status.status}.`); }
          catch (error) { if (error.code !== "ENOENT") throw error; console.log(`VERIFIED ON DISK: ${item.filename} does not exist (${status.status}).`); }
        }
      }
    } catch (error) { console.error(`Demo status check: ${error.message}`); }
    finally { polling = false; }
  }, 3000);
  const stop = async () => { clearInterval(timer); await session.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) { await session.close(); throw error; }
