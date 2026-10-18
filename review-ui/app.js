"use strict";
const token = new URLSearchParams(location.hash.slice(1)).get("token");
history.replaceState(null, "", location.pathname);
const $ = id => document.getElementById(id);
let signature = "";
let busy = false;
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
async function api(path, data) {
  const response = await fetch(path, {
    method: data ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json" } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "The gateway could not complete this request.");
  return value;
}
function field(label, value, code = false) {
  const container = node("div", undefined, "field");
  container.append(node("span", label, "small-label"), node(code ? "pre" : "p", value));
  return container;
}
function pendingCard(action) {
  const card = node("article", undefined, "action-card");
  const top = node("div", undefined, "card-top");
  top.append(node("span", action.status === "REVIEWING" ? "REVALIDATING" : "APPROVAL REQUIRED", "badge pending"));
  const expiry = node("span", "", "expiry");
  expiry.dataset.expires = action.expiresAt;
  top.append(expiry);
  const title = node("h3", action.toolName);
  const labels = node("p", `${action.agentId || "Unlabeled agent"} / ${action.workflowId || "Unlabeled workflow"}`, "muted");
  card.append(top, title, labels, field("ORIGINAL USER REQUEST", action.userIntent));
  const scores = node("div", undefined, "scores");
  scores.append(node("span", `Risk score ${Math.round(action.safety.riskScore * 100)}%`), node("span", `Intent match ${Math.round(action.safety.intentMatchScore * 100)}%`));
  card.append(scores, node("p", action.safety.reason, "reason"), field("EXACT TOOL ARGUMENTS", JSON.stringify(action.arguments, null, 2), true));
  card.append(node("p", "Approval forwards these saved arguments once, after another safety check.", "muted"));
  const controls = node("div", undefined, "controls");
  for (const [decision, label] of [["approve", "Approve once"], ["deny", "Deny action"]]) {
    const button = node("button", label, decision === "approve" ? "primary" : "secondary");
    button.type = "button";
    button.disabled = action.status !== "PENDING";
    button.addEventListener("click", () => decide(action, decision));
    controls.append(button);
  }
  card.append(controls);
  const detail = node("details");
  detail.append(node("summary", "Action identity and evaluator"), node("pre", `ID: ${action.id}\nSHA-256: ${action.fingerprint}\nEvaluator: ${action.safety.evaluator?.source || "Local validation"}${action.safety.evaluator?.requestId ? `\nJev request: ${action.safety.evaluator.requestId}` : ""}`, "identity"));
  card.append(detail);
  return card;
}
function historyCard(action) {
  const card = node("article", undefined, "history-card");
  card.append(node("span", action.status, `badge ${action.status === "EXECUTED" ? "success" : "stopped"}`), node("h3", action.toolName), node("p", action.note || "No upstream execution.", "muted"));
  card.append(node("time", new Date(action.reviewedAt || action.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
  const detail = node("details");
  detail.append(node("summary", "View arguments and result"), field("ARGUMENTS", JSON.stringify(action.arguments, null, 2), true));
  if (action.result) detail.append(field("MCP RESULT", JSON.stringify(action.result, null, 2), true));
  card.append(detail);
  return card;
}
function render(approvals) {
  const waiting = approvals.filter(action => ["PENDING", "REVIEWING"].includes(action.status));
  const done = approvals.filter(action => !["PENDING", "REVIEWING"].includes(action.status))
    .sort((a, b) => Date.parse(b.reviewedAt || b.createdAt) - Date.parse(a.reviewedAt || a.createdAt));
  $("pending-count").textContent = waiting.length;
  $("executed-count").textContent = done.filter(action => action.status === "EXECUTED").length;
  $("stopped-count").textContent = done.filter(action => action.status !== "EXECUTED").length;
  $("queue-label").textContent = `${waiting.length} action${waiting.length === 1 ? "" : "s"}`;
  $("pending").replaceChildren(...(waiting.length ? waiting.map(pendingCard) : [node("div", "All clear. Actions that need your approval will appear here.", "empty")]));
  $("history").replaceChildren(...(done.length ? done.map(historyCard) : [node("div", "Your decisions and tool results will appear here.", "empty")]));
  updateTimers();
}
function updateTimers() {
  for (const element of document.querySelectorAll("[data-expires]")) {
    const seconds = Math.max(0, Math.ceil((Date.parse(element.dataset.expires) - Date.now()) / 1000));
    element.textContent = seconds ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Expired";
  }
}
async function refresh() {
  if (busy) return;
  try {
    const state = await api("/api/state");
    const next = JSON.stringify(state.approvals);
    if (next !== signature) { signature = next; render(state.approvals); }
    $("connection").textContent = "● Gateway connected";
    $("connection").classList.add("online");
  } catch (error) {
    $("connection").textContent = "Gateway unavailable";
    $("connection").classList.remove("online");
    $("error").textContent = error.message;
    $("error").hidden = false;
  }
}
async function decide(action, decision) {
  if (busy) return;
  busy = true;
  $("error").hidden = true;
  $("notice").hidden = false;
  $("notice").textContent = decision === "approve" ? "Rechecking safety and forwarding the approved action…" : "Recording your decision…";
  for (const button of document.querySelectorAll("button")) button.disabled = true;
  try {
    const result = await api(`/api/approvals/${action.id}/decision`, { decision, fingerprint: action.fingerprint });
    $("notice").textContent = `${result.status}: ${result.note}`;
  } catch (error) {
    $("notice").hidden = true;
    $("error").hidden = false;
    $("error").textContent = `${error.message} Check the latest status below; this page does not automatically retry an approval.`;
  } finally { busy = false; signature = ""; await refresh(); }
}
if (!token) {
  $("connection").textContent = "Private link required";
  $("error").textContent = "Open the complete private review link printed in your terminal. If you refreshed the page, open that link again.";
  $("error").hidden = false;
} else { void refresh(); setInterval(refresh, 1500); setInterval(updateTimers, 1000); }
