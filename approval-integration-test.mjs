import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDemoSession } from "./gateway-session.mjs";

test("REAL browser API + STDIO gateway + official Filesystem MCP: hold, deny, approve once, read result", { timeout: 40000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "approval-integration-"));
  const session = await openDemoSession({ directory, reviewPort: 0, intent: "Create allowed.txt and denied.txt with reviewed content. Do not delete files.", quiet: true, auditPath: join(directory, "audit.jsonl") });
  const link = new URL(session.reviewUrl);
  const headers = { Authorization: `Bearer ${new URLSearchParams(link.hash.slice(1)).get("token")}`, Origin: link.origin, "Content-Type": "application/json" };
  const api = (path, init) => fetch(`${link.origin}${path}`, init);
  const review = (id, body, customHeaders = headers) => api(`/api/approvals/${id}/decision`, { method: "POST", headers: customHeaders, body: JSON.stringify(body) });
  try {
    const page = await api("/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal((await api("/app.js")).status, 200);
    assert.equal((await api("/api/state")).status, 401);
    assert.equal((await api("/api/state", { headers: { ...headers, Origin: "https://attacker.example" } })).status, 403);
    const tools = (await session.client.listTools()).tools;
    assert.ok(tools.some(tool => tool.name === "get_approval_status"));
    assert.ok(!tools.some(tool => /approve|decision/.test(tool.name)));
    const queue = async name => {
      const result = await session.client.callTool({ name: "write_file", arguments: { path: join(directory, name), content: "Reviewed content\n" } });
      assert.equal(result._meta.safetyGateway.decision, "REQUIRE_APPROVAL");
      await assert.rejects(access(join(directory, name)), { code: "ENOENT" });
      const state = await (await api("/api/state", { headers })).json();
      return state.approvals.find(action => action.id === result._meta.safetyGateway.approval.id);
    };
    const denied = await queue("denied.txt");
    assert.equal((await review(denied.id, { decision: "deny", fingerprint: denied.fingerprint })).status, 200);
    await assert.rejects(access(join(directory, "denied.txt")), { code: "ENOENT" });
    const action = await queue("allowed.txt");
    const payload = { decision: "approve", fingerprint: action.fingerprint };
    assert.equal((await review(action.id, payload, { Origin: link.origin, "Content-Type": "application/json" })).status, 401);
    assert.equal((await review(action.id, payload, { ...headers, Origin: "https://attacker.example" })).status, 403);
    assert.equal((await review(action.id, payload, { Authorization: headers.Authorization, "Content-Type": "application/json" })).status, 403);
    assert.equal((await review(action.id, { ...payload, arguments: { path: "elsewhere.txt" } })).status, 400);
    assert.equal((await review(action.id, { ...payload, fingerprint: "0".repeat(64) })).status, 409);
    await assert.rejects(access(join(directory, "allowed.txt")), { code: "ENOENT" });
    const decisions = await Promise.all([review(action.id, payload), review(action.id, payload)]);
    assert.deepEqual(decisions.map(response => response.status).sort(), [200, 409]);
    const done = await decisions.find(response => response.status === 200).json();
    assert.equal(done.status, "EXECUTED");
    assert.equal(await readFile(join(directory, "allowed.txt"), "utf8"), "Reviewed content\n");
    const status = await session.client.callTool({ name: "get_approval_status", arguments: { id: action.id } });
    assert.equal(JSON.parse(status.content[0].text).status, "EXECUTED");
    assert.deepEqual(JSON.parse(status.content[0].text).result, done.result);
    assert.ok(!JSON.stringify(status).includes(link.hash.slice(7)));
    const events = (await readFile(join(directory, "audit.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.filter(event => event.executed).length, 1);
    assert.equal(events.filter(event => event.eventType === "approval_authorization").length, 1);
  } finally { await session.close(); }
  await assert.rejects(api("/api/state", { headers }), /fetch failed/);
});

test("REAL filesystem gateway: a blocked action never enters the browser queue", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "approval-blocked-"));
  const session = await openDemoSession({ directory, reviewPort: 0, intent: "Read report.txt. Do not modify files.", quiet: true, auditPath: join(directory, "audit.jsonl") });
  try {
    const result = await session.client.callTool({ name: "write_file", arguments: { path: join(directory, "report.txt"), content: "HACKED" } });
    assert.equal(result._meta.safetyGateway.decision, "BLOCK");
    assert.equal(result._meta.safetyGateway.approval, undefined);
    const link = new URL(session.reviewUrl);
    const state = await (await fetch(`${link.origin}/api/state`, { headers: { Authorization: `Bearer ${new URLSearchParams(link.hash.slice(1)).get("token")}` } })).json();
    assert.deepEqual(state.approvals, []);
    await assert.rejects(access(join(directory, "report.txt")), { code: "ENOENT" });
  } finally { await session.close(); }
});
