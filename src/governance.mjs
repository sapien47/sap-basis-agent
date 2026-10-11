// Governance for write actions: a human approval step and an audit log.
// Fail closed: without an explicit human "approve", nothing is changed.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askInWindow } from "./approval-window.mjs";
import { openWorkflow } from "./workflow-window.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AUDIT_FILE = process.env.AUDIT_FILE || path.join(projectRoot, "logs", "audit.jsonl");

// Who sits at the keyboard. Overridable, e.g. for anonymised demos.
const operator = () => process.env.AUDIT_OPERATOR || os.userInfo().username;

export const newRequestId = () => "REQ-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();

// APPROVAL_CHANNEL=window (default): the server's own page in the browser, works with any client.
// APPROVAL_CHANNEL=client: a dialog in the AI client (MCP elicitation), only where the client really shows it.
const channel = () => process.env.APPROVAL_CHANNEL || "window";
const approvalTimeout = () => Number(process.env.APPROVAL_TIMEOUT_SECONDS) || 300;

// Ask the human. Returns { approved, comment, answeredBy }.
export async function askHuman(mcpServer, message) {
  return channel() === "client" ? askInClient(mcpServer, message) : askInOwnWindow(message);
}

// A write request run as a visible workflow. Window channel: the live workflow page, where the human
// starts the request, decides on an SoD conflict (stop, or override with a justification) and
// approves. Client channel: no page; the SoD conflict goes into the single approval dialog, and
// approving it accepts the conflict, with the comment as justification.
// Returns { page, begin, step, note, sodDecision, approve, handOver, end }.
export async function openFlow(mcpServer, { title, requestId, facts, steps }) {
  const noop = () => {};
  if (channel() === "client") {
    return {
      page: false, step: noop, note: noop, end: noop, handOver: () => null,
      begin: async () => ({ started: true }),
      sodDecision: async () => ({ decidedAtApproval: true }),
      approve: (message) => askInClient(mcpServer, message),
    };
  }
  const who = operator();
  let wf;
  try {
    wf = await openWorkflow({ title, requestId, facts, steps, operator: who, timeoutSeconds: approvalTimeout() });
  } catch (err) {
    const comment = `workflow page failed: ${err.message.slice(0, 200)}`;
    return { page: false, step: noop, note: noop, end: noop, begin: async () => ({ started: false, status: "not approved: dialog failed", comment }) };
  }
  const noAnswer = `no answer in the workflow page within ${approvalTimeout()} s`;
  return {
    page: true, step: wf.step, note: wf.note, end: wf.end,
    async begin() {
      const a = await wf.ask({
        title: "Ready to start",
        text: "The AI agent prepared this request. No user data is read and nothing is changed in SAP until you click Start.",
        options: [{ value: "cancel", label: "Cancel", style: "bad" }, { value: "start", label: "Start workflow", style: "ok" }],
      });
      if (a.value === "start") { wf.note("Workflow started", who); return { started: true }; }
      if (a.value === "cancel") { wf.note("Workflow cancelled before start", who); return { started: false, status: "cancelled by human", comment: null }; }
      return { started: false, status: "not approved: no human answer", comment: noAnswer };
    },
    // Resolves to { override: true|false, justification, by } or { noAnswer: true }.
    async sodDecision(text) {
      const a = await wf.ask({
        title: "SoD conflict: your decision",
        tone: "warn",
        text,
        justification: "required",
        options: [
          { value: "stop", label: "Stop the request", style: "bad" },
          { value: "override", label: "Override and continue", style: "ovr", needsText: true },
        ],
      });
      if (a.value === "timeout") return { noAnswer: true, comment: noAnswer };
      const override = a.value === "override";
      wf.note(override ? `SoD conflict overridden. Justification: ${a.text}` : `Stopped because of the SoD conflict${a.text ? `: ${a.text}` : ""}`, who);
      return { override, justification: a.text, by: who };
    },
    async approve(message) {
      const a = await wf.ask({
        title: "Approval: the agent will now change SAP",
        text: message,
        justification: "optional",
        options: [{ value: "reject", label: "Reject", style: "bad" }, { value: "approve", label: "Approve", style: "ok" }],
      });
      if (a.value === "timeout") return { approved: false, noAnswer: true, comment: noAnswer, answeredBy: null };
      wf.note(`${a.value === "approve" ? "Approved" : "Rejected"}${a.text ? `: ${a.text}` : ""}`, who);
      return { approved: a.value === "approve", comment: a.text, answeredBy: who };
    },
    handOver(label, secret) {
      wf.setSecret(label, secret);
      return "shown once to the human in the workflow page, not to the AI";
    },
  };
}

async function askInOwnWindow(message) {
  const timeoutSeconds = approvalTimeout();
  let res;
  try {
    res = await askInWindow(message, { operator: operator(), timeoutSeconds });
  } catch (err) {
    return { approved: false, comment: `approval window failed: ${err.message.slice(0, 200)}`, answeredBy: null };
  }
  if (res.action !== "accept") {
    return { approved: false, noAnswer: true, comment: `no answer in the approval window within ${timeoutSeconds} s`, answeredBy: null };
  }
  return { approved: res.content.approve, comment: res.content.comment || null, answeredBy: operator() };
}

async function askInClient(mcpServer, message) {
  if (!mcpServer.getClientCapabilities()?.elicitation) {
    return { approved: false, unsupported: true, comment: "The AI client cannot show approval dialogs, so no change was made." };
  }
  let res;
  try {
    res = await mcpServer.elicitInput({
      message,
      requestedSchema: {
        type: "object",
        properties: {
          approve: { type: "boolean", title: "Approve this change?", description: "Tick to approve, leave empty to reject" },
          comment: { type: "string", title: "Comment (optional)" },
        },
        required: ["approve"],
      },
    });
  } catch (err) {
    // A broken dialog is treated as "not approved" (and audited by the caller).
    return { approved: false, comment: `approval dialog failed: ${err.message.slice(0, 200)}`, answeredBy: null };
  }
  // Only a submitted form is a human answer. A "decline" or "cancel" can come from the client
  // itself (e.g. one that cannot render the dialog), so it is not attributed to the operator.
  if (res.action !== "accept") {
    return { approved: false, noAnswer: true, comment: `no human answer: the AI client returned "${res.action}"`, answeredBy: null };
  }
  return {
    approved: res.content?.approve === true,
    comment: res.content?.comment || null,
    answeredBy: operator(),
  };
}

// Audit status for a request that was not approved.
export const refusalStatus = (approval) =>
  approval.unsupported ? "refused: no approval channel"
  : approval.noAnswer ? "not approved: no human answer"
  : approval.answeredBy === null ? "not approved: dialog failed"
  : "rejected by human";

export async function audit(entry) {
  const record = {
    time: new Date().toISOString(),
    operator: operator(),
    executedAsSapUser: process.env.SAP_USER,
    ...entry,
  };
  await mkdir(path.dirname(AUDIT_FILE), { recursive: true });
  await appendFile(AUDIT_FILE, JSON.stringify(record) + "\n");
  return record;
}

export async function readAudit({ limit = 20 } = {}) {
  let text = "";
  try {
    text = await readFile(AUDIT_FILE, "utf8");
  } catch {
    return { count: 0, entries: [] };
  }
  const entries = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { total: entries.length, entries: entries.slice(-limit).reverse() };
}
