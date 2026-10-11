// End-to-end test of the ticket use cases, against the real SAP system, through the approval window
// and the workflow pages. The script plays the human: it clicks Start / Approve and opens the password.
//   1. diagnose access (read-only)   2. deactivate a leaver   3. diagnose again
//   4. reactivate with a new password   5. create a user like a colleague
// Touches DEMO_03 (ends reactivated) and creates NEW_USER (default DEMO_05) once; later runs check "already exists".
// Usage: node --env-file=.env scripts/ticket-test.js

import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures++;
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.js"],
  env: { ...process.env, APPROVAL_CHANNEL: "window", APPROVAL_NO_BROWSER: "1" },
  stderr: "pipe",
});
// Links the server prints instead of opening a browser, by kind: "approval", "workflow" or "secret".
const links = { approval: [], workflow: [], secret: [] };
const waiters = { approval: [], workflow: [], secret: [] };
transport.stderr.on("data", (chunk) => {
  for (const m of String(chunk).matchAll(/\[(approval|workflow|secret)\] (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+)/g)) {
    const w = waiters[m[1]].shift();
    w ? w(m[2]) : links[m[1]].push(m[2]);
  }
});
const nextLink = (kind) => (links[kind].length ? Promise.resolve(links[kind].shift()) : new Promise((r) => waiters[kind].push(r)));
const client = new Client({ name: "ticket-test", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
  return { raw: res.content[0].text, json: JSON.parse(res.content[0].text) };
};
// Call a write tool and click Approve on its approval page.
async function approved(name, args) {
  const pending = call(name, args);
  const link = await nextLink("approval");
  const page = await (await fetch(link)).text();
  await fetch(link, { method: "POST", body: new URLSearchParams({ decision: "approve", comment: "test" }) });
  return { ...(await pending), page };
}
// Call a write tool that runs as a workflow page: click Start, then Approve if asked.
// Returns the approval text as `page`, and the workflow link.
async function viaWorkflow(name, args) {
  const pending = call(name, args);
  const link = await nextLink("workflow");
  const ask = async (title) => {
    for (;;) {
      const s = await (await fetch(`${link}/state`)).json();
      if (s.prompt?.title.includes(title)) return s;
      if (s.result) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const click = (s, value) => fetch(`${link}/answer`, { method: "POST", body: JSON.stringify({ promptId: s.prompt.id, value, text: "test" }) });
  await click(await ask("Ready to start"), "start");
  const s = await ask("Approval");
  if (s) await click(s, "approve");
  return { ...(await pending), page: s?.prompt.text || "", link };
}
// Show the password once on a workflow page; return it, and whether a second try still got it.
async function workflowPassword(link) {
  const first = await fetch(`${link}/secret`, { method: "POST" });
  const again = await fetch(`${link}/secret`, { method: "POST" });
  return { password: first.ok ? (await first.json()).value : null, openedTwice: again.ok };
}
// Open the one-time password page; return the password shown on it.
async function readPassword() {
  const link = await nextLink("secret");
  const html = await (await fetch(link)).text();
  const again = await fetch(link).then((r) => r.text()).catch(() => "closed");
  return { password: html.match(/<pre[^>]*>([^<]+)<\/pre>/)?.[1], openedTwice: !/already opened|closed/.test(again) && again.includes("<pre") };
}

const today = new Date().toLocaleDateString("en-CA");
const NEW_USER = process.env.NEW_USER || "DEMO_05";

console.log("1. Diagnose: a user that does not exist, and a healthy one");
let r = (await call("sap_diagnose_access", { username: "DEMO_99" })).json;
check(r.verdict === "cannot log on" && /does not exist/.test(r.findings[0].finding), `DEMO_99: ${r.verdict}`);
r = (await call("sap_diagnose_access", { username: "DEMO_03", replyLanguage: "fr" })).json;
console.log(`  DEMO_03 before: ${r.verdict} | ${r.findings.map((f) => f.finding).join(" | ")}`);
check(typeof r.ticketReply === "string" && r.ticketReply.startsWith("Bonjour"), "French ticket reply drafted");

console.log("\n2. Deactivate DEMO_03 (leaver)");
r = await viaWorkflow("sap_deactivate_users", { usernames: ["DEMO_03", "DDIC"], reason: "test: ticket leaver" });
check(r.page.includes("DEACTIVATE") && r.page.includes("DEMO_03"), "workflow page shows the plan");
check(r.json.status === "done", `status = ${r.json.status}`);
check(r.json.results?.[0]?.stateAfter?.locked === true && r.json.results[0].stateAfter.validTo === today, `locked, valid to ${r.json.results?.[0]?.stateAfter?.validTo}`);
check(r.json.skipped.some((s) => s.username === "DDIC"), "DDIC skipped (protected)");
check(r.json.ticketReply?.includes("DEMO_03"), "ticket reply drafted");
r = (await viaWorkflow("sap_deactivate_users", { usernames: ["DEMO_03"], reason: "test: twice" })).json;
check(r.status === "nothing to do", `second deactivation: ${r.status}`);

console.log("\n3. Diagnose DEMO_03 again");
r = (await call("sap_diagnose_access", { username: "DEMO_03" })).json;
console.log(`  ${r.verdict} | ${r.findings.map((f) => f.finding).join(" | ")}`);
check(r.verdict === "cannot log on" && r.findings.some((f) => /locked by an administrator/.test(f.finding)), "finds the administrator lock");

console.log("\n4. Reactivate DEMO_03 with a new initial password");
r = await approved("sap_reactivate_user", { username: "DEMO_03", reason: "test: ticket reactivation" });
console.log(`  result: ${JSON.stringify({ status: r.json.status, stateAfter: r.json.stateAfter, initialPassword: r.json.initialPassword })}`);
check(r.json.status === "done", `status = ${r.json.status}`);
check(r.json.stateAfter?.locked === false && r.json.stateAfter.validTo > today, `unlocked, valid to ${r.json.stateAfter?.validTo}`);
let pw = await readPassword();
check(Boolean(pw.password), "password page shows a password");
check(!pw.openedTwice, "password page cannot be opened twice");
check(pw.password && !r.raw.includes(pw.password), "the AI's answer does not contain the password");
check(pw.password && !(await readFile("logs/audit.jsonl", "utf8")).includes(pw.password), "the audit log does not contain the password");
check(r.json.ticketReply?.includes("unlocked"), "ticket reply drafted");

console.log(`\n5. Create ${NEW_USER} like DEMO_01`);
const exists = !(await client.callTool({ name: "sap_get_user", arguments: { username: NEW_USER } })).isError;
const templateRoles = (await call("sap_get_user", { username: "DEMO_01" })).json.roles.map((x) => x.role).sort();
if (exists) {
  r = (await viaWorkflow("sap_create_user_like", { newUsername: NEW_USER, templateUsername: "DEMO_01", firstName: "Demo", lastName: NEW_USER, reason: "test" })).json;
  check(r.status === "not possible", `${NEW_USER} exists already: ${r.status}`);
} else {
  r = await viaWorkflow("sap_create_user_like", { newUsername: NEW_USER, templateUsername: "DEMO_01", firstName: "Demo", lastName: NEW_USER, reason: "test: ticket new joiner" });
  check(r.json.status === "done", `status = ${r.json.status}`);
  check(r.json.user?.roles.slice().sort().join() === templateRoles.join(), `same roles as DEMO_01 (${templateRoles.length}): ${r.json.user?.roles.join(", ")}`);
  pw = await workflowPassword(r.link);
  check(Boolean(pw.password) && !pw.openedTwice, "workflow page shows the password once");
  check(pw.password && !r.raw.includes(pw.password), "the AI's answer does not contain the password");
  check(pw.password && !(await readFile("logs/audit.jsonl", "utf8")).includes(pw.password), "the audit log does not contain the password");
  check(r.json.ticketReply?.includes(NEW_USER), "ticket reply drafted");
}

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
