// README screenshots of the live workflow page, with demo data only: no SAP connection, no .env.
// Uses the real page (src/workflow-window.mjs), moves a "create user like" request to three moments
// (SoD decision, approval, finished) and saves each as a PNG with headless Chrome or Edge.
// Run: node scripts/screenshot-workflow.mjs   ->  docs/img/workflow-*.png
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkflow } from "../src/workflow-window.mjs";
import { created } from "../src/replies.mjs";
import { sodLines } from "../src/actions.mjs";

process.env.APPROVAL_NO_BROWSER = "1";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs", "img");
mkdirSync(outDir, { recursive: true });

const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
];
const browser = process.env.BROWSER_PATH || BROWSERS.find(existsSync);
if (!browser) throw new Error("No Chrome or Edge found: set BROWSER_PATH");

// Demo data (same shape as a real run, nothing from a real system).
const OPERATOR = "basis.admin";
const SYS = "SBX/100 (sandbox)";
const NEW = "DEMO_08", TEMPLATE = "DEMO_TPL_P2P", FIRST = "Demo User", LAST = "08";
const REASON = "Ticket 4711: new joiner, create DEMO_08 like DEMO_TPL_P2P";
const REQUEST = "REQ-20261011093000-DEMO";
const ROLES = [
  { role: "SAP_BR_AP_ACCOUNTANT_PROCUREMT", text: "Accounts Payable Accountant - Procurement" },
  { role: "SAP_BR_PURCHASER", text: "Purchaser" },
];
const SOD = {
  verdict: "1 SoD conflict(s) found: needs an explicit, justified approval or a different role set",
  conflicts: [{
    id: "R03", level: "High", risk: "Order and invoice your own purchase",
    because: [
      { function: "Create or change purchase orders", roles: ["SAP_BR_PURCHASER (Manage Purchase Orders)"] },
      { function: "Enter supplier invoices", roles: ["SAP_BR_AP_ACCOUNTANT_PROCUREMT (Create Supplier Invoice, Upload Supplier Invoices)"] },
    ],
  }],
  notChecked: [],
};
const DECISION = { override: true, by: OPERATOR, justification: "Small site, no second buyer available; monthly review of POs and invoices by the finance lead" };
const STEPS = [
  { id: "parse", label: "Parse request" },
  { id: "check", label: "Check user names" },
  { id: "template", label: "Read template roles" },
  { id: "sod", label: "SoD conflict check" },
  { id: "approve", label: "Human approval" },
  { id: "create", label: "Create SAP user" },
  { id: "roles", label: "Copy template roles" },
  { id: "verify", label: "Verify in SAP" },
  { id: "handover", label: "Hand over password" },
  { id: "close", label: "Audit log & ticket reply" },
];

// Same texts as createUserLike in src/actions.mjs, up to the given moment.
async function stage(name) {
  const lines = [];
  const orig = console.error;
  console.error = (m) => lines.push(String(m));
  const wf = await openWorkflow({
    title: `Create SAP user ${NEW} like ${TEMPLATE}`, requestId: REQUEST, operator: OPERATOR, steps: STEPS,
    facts: [["New user", `${NEW} (${FIRST} ${LAST})`], ["Copied from", TEMPLATE], ["System", SYS], ["Reason", REASON]],
  });
  console.error = orig;
  const url = lines.find((l) => l.startsWith("[workflow] ")).slice(11);

  wf.note("Workflow started", OPERATOR);
  wf.step("parse", "done", `New user ${NEW} (${FIRST} ${LAST}), copied from ${TEMPLATE}.\nReason: ${REASON}`);
  wf.step("check", "done", `${NEW} is free. Template ${TEMPLATE} exists: Dialog user, valid to unlimited.`);
  wf.note(`Read ${TEMPLATE} with BAPI_USER_GET_DETAIL`);
  wf.step("template", "done", `${ROLES.length} role(s):\n` + ROLES.map((r) => `  - ${r.role} (${r.text})`).join("\n"));
  wf.step("sod", "warning", sodLines(SOD));
  wf.note(`SoD check found 1 conflict(s): R03 High: Order and invoice your own purchase`);

  if (name === "sod") {
    wf.ask({
      title: "SoD conflict: your decision", tone: "warn", justification: "required",
      text: sodLines(SOD) + "\n\nOne person should not hold these together. Stop the request, or override it with a justification (written to the audit log).",
      options: [{ value: "stop", label: "Stop the request", style: "bad" }, { value: "override", label: "Override and continue", style: "ovr", needsText: true }],
    });
    return { url, wf };
  }
  wf.note(`SoD conflict overridden. Justification: ${DECISION.justification}`, OPERATOR);
  wf.step("sod", "overridden", sodLines(SOD, DECISION));
  wf.step("approve", "running", "Waiting for your approval.");

  if (name === "approve") {
    wf.ask({
      title: "Approval: the agent will now change SAP", justification: "optional",
      text:
        `The AI agent asks to CREATE SAP user ${NEW} (${FIRST} ${LAST}) in ${SYS}, copied from ${TEMPLATE}:\n` +
        `  - user type: Dialog, user group: none, valid to: unlimited\n` +
        `  - roles (${ROLES.length}): ${ROLES.map((r) => r.role).join(", ")}\n` +
        `  - initial password generated by SAP, shown only to you in the browser after creation\n` +
        `${sodLines(SOD, DECISION)}\n` +
        `Reason given: ${REASON}\nRequest ${REQUEST}`,
      options: [{ value: "reject", label: "Reject", style: "bad" }, { value: "approve", label: "Approve", style: "ok" }],
    });
    return { url, wf };
  }
  wf.note("Approved", OPERATOR);
  wf.step("approve", "done", `Approved by ${OPERATOR}`);
  wf.step("create", "done", `BAPI_USER_CREATE1: User ${NEW} created`);
  wf.note(`Called BAPI_USER_CREATE1 for ${NEW}: OK`);
  wf.step("roles", "done", `BAPI_USER_ACTGROUPS_ASSIGN, ${ROLES.length} role(s): Role assignment to user ${NEW} changed`);
  wf.note(`Called BAPI_USER_ACTGROUPS_ASSIGN for ${NEW}: OK`);
  wf.step("verify", "done", `Read back from SAP: Dialog user, ${ROLES.length} role(s): ${ROLES.map((r) => r.role).join(", ")}`);
  wf.setSecret("initial password", "not-a-real-password");
  wf.step("handover", "done", "Shown once to the human in this page, never to the AI.");
  wf.step("close", "done", `Audit log entry ${REQUEST} written.\nTicket reply ready (see Result).`);
  const user = { username: NEW, fullName: `${FIRST} ${LAST}`, validTo: null, roles: ROLES.map((r) => r.role) };
  wf.end("done", created(user, TEMPLATE, SYS, "en"));
  return { url, wf };
}

const SHOTS = [
  ["sod", "workflow-1-sod-decision.png", 1100],
  ["approve", "workflow-2-approval.png", 1210],
  ["done", "workflow-3-done.png", 1370],
];
for (const [name, file, height] of SHOTS) {
  const { url } = await stage(name);
  const profile = mkdtempSync(path.join(os.tmpdir(), "wf-shot-"));
  const out = path.join(outDir, file);
  // Asynchronous on purpose: the page is served by this same process, which must keep answering.
  const err = await new Promise((resolve) => execFile(browser, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--force-color-profile=srgb",
    `--user-data-dir=${profile}`, `--window-size=1280,${height}`, "--virtual-time-budget=4000",
    `--screenshot=${out}`, url,
  ], { timeout: 60000 }, (e) => resolve(e)));
  rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  console.log(existsSync(out) ? `saved ${path.relative(root, out)}` : `FAILED ${file}: ${err?.message || "no file"}`);
}
process.exit(0);
