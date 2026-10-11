// Live test of the workflow pages on the real SAP system. A scripted "human" clicks the page's
// buttons over HTTP, as a browser would.
// sap_create_user_like: (1) cancel before start, (2) SoD conflict, override without justification
//   refused, then stop, (3) override with justification, approve, user created, password shown once.
//   Template DEMO_TPL_P2P (Purchaser + AP accountant = R03). Creates DEMO_WF01, deleted at the end.
// sap_assign_roles: (5) role already assigned, (6) SoD conflict, stop, (7) add a role to a user with
//   roles, approve, old roles kept. Changes DEMO_03, restored to its original roles at the end.
// sap_deactivate_users: (9) protected and missing users skipped, human rejects, (10) two leavers
//   approved: locked, validity ends today, roles kept, (11) again: nothing to do. Changes DEMO_05
//   and DEMO_07, given back their state (unlocked, no end date) at the end.
// Usage: node --env-file=.env scripts/workflow-test.js [create|roles|leavers]   (default: all)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callRfc, messages } from "../src/sap-soap.mjs";
import { setRoles, unlockUser } from "../src/users.mjs";

const NEW = "DEMO_WF01";
const TEMPLATE = "DEMO_TPL_P2P";
const ROLE_USER = "DEMO_03";
const NEW_ROLE = "SAP_BR_INVENTORY_MANAGER";
const LEAVERS = ["DEMO_05", "DEMO_07"];
const part = process.argv[2] || "all";

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const transport = new StdioClientTransport({
  command: process.execPath, args: ["src/server.js"], stderr: "pipe",
  env: { ...process.env, APPROVAL_CHANNEL: "window", APPROVAL_NO_BROWSER: "1", APPROVAL_TIMEOUT_SECONDS: "60" },
});
// Workflow page links, in the order the server prints them on stderr.
const links = [];
transport.stderr.on("data", (d) => { for (const m of String(d).matchAll(/\[workflow\] (\S+)/g)) links.push(m[1]); });
const client = new Client({ name: "workflow-test", version: "1.0.0" });
await client.connect(transport);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 5 * 60 * 1000 });
  if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
  return JSON.parse(res.content[0].text);
}
const exists = async (u) => { try { await call("sap_get_user", { username: u }); return true; } catch { return false; } };

// The scripted human: wait for the next page and for a question whose title contains `title`.
let page = null;
async function nextPage() {
  for (let i = 0; i < 100 && !links.length; i++) await sleep(100);
  page = links.shift();
  return page;
}
const state = async () => (await fetch(`${page}/state`)).json();
async function waitPrompt(title) {
  for (let i = 0; i < 300; i++) {
    const s = await state();
    if (s.prompt?.title.includes(title)) return s;
    if (s.result) throw new Error(`workflow ended (${s.result.status}) before "${title}"`);
    await sleep(200);
  }
  throw new Error(`no prompt "${title}"`);
}
async function answer(title, value, text) {
  const s = await waitPrompt(title);
  console.log(`  [human] "${s.prompt.title}" -> ${value}${text ? ` ("${text}")` : ""}`);
  return fetch(`${page}/answer`, { method: "POST", body: JSON.stringify({ promptId: s.prompt.id, value, text }) });
}
const args = { newUsername: NEW, templateUsername: TEMPLATE, firstName: "Workflow", lastName: "Test", reason: "test: workflow page" };

const getUser = (u) => call("sap_get_user", { username: u });
const roleList = async (u) => (await getUser(u)).roles;
const names = (roles) => roles.map((x) => x.role).sort().join(", ");
const existedBefore = await exists(NEW);
const rolesBefore = await roleList(ROLE_USER);
const leaversBefore = await Promise.all(LEAVERS.map(getUser));
let pending, s, r;
try {
  if (part === "all" || part === "create") await createTests();
  if (part === "all" || part === "roles") await roleTests();
  if (part === "all" || part === "leavers") await leaverTests();
} finally {
  for (const b of leaversBefore) {
    const now = await getUser(b.username);
    if (now.locked === b.locked && now.validTo === b.validTo) continue;
    console.log(`\n12. Clean-up: give ${b.username} back its state (${b.locked ? "locked" : "unlocked"}, valid to ${b.validTo || "no end date"})`);
    if (!b.locked) await unlockUser(b.username);
    // 0000-00-00 = no end date.
    await callRfc("BAPI_USER_CHANGE", `<USERNAME>${b.username}</USERNAME><LOGONDATA><GLTGB>${b.validTo || "0000-00-00"}</GLTGB></LOGONDATA><LOGONDATAX><GLTGB>X</GLTGB></LOGONDATAX><RETURN></RETURN>`);
    const after = await getUser(b.username);
    check(after.locked === b.locked && after.validTo === b.validTo && after.roles.length === b.roles.length, `${b.username} back to ${after.locked ? "locked" : "unlocked"}, valid to ${after.validTo || "no end date"}, ${after.roles.length} role(s)`);
  }
  if (!existedBefore && (await exists(NEW))) {
    console.log(`\n4. Clean-up: delete ${NEW}, created by this test`);
    const res = await callRfc("BAPI_USER_DELETE", `<USERNAME>${NEW}</USERNAME><RETURN></RETURN>`);
    for (const m of messages(res.body)) console.log(`  [${m.type}] ${m.message}`);
    check(!(await exists(NEW)), `${NEW} deleted`);
  }
  if (names(await roleList(ROLE_USER)) !== names(rolesBefore)) {
    console.log(`\n8. Clean-up: restore ${ROLE_USER} to its original roles`);
    const res = await setRoles(ROLE_USER, rolesBefore.map((x) => ({ role: x.role, validFrom: x.validFrom, validTo: x.validTo })));
    check(res.ok && names(await roleList(ROLE_USER)) === names(rolesBefore), `${ROLE_USER} restored: ${names(rolesBefore)}`);
  }
  await client.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);

async function leaverTests() {
  const [a, b] = LEAVERS;
  const today = new Date().toLocaleDateString("sv");
  check(leaversBefore.every((u) => !u.locked && !u.validTo), `${LEAVERS.join(", ")} unlocked, no end date`);

  console.log(`\n9. Leavers ${a} + DDIC + a missing user, human rejects`);
  pending = call("sap_deactivate_users", { usernames: [a, "DDIC", "DEMO_NOPE"], reason: "test: leaver, reject" });
  await nextPage();
  s = await state();
  check(s.steps.length === 8 && s.steps.every((x) => x.state === "waiting"), "8 steps, all waiting before start");
  await answer("Ready to start", "start");
  s = await waitPrompt("Approval");
  const check2 = s.steps.find((x) => x.id === "check").detail;
  check(check2.includes("DDIC (protected") && check2.includes("DEMO_NOPE (user does not exist)"), "protected and missing users shown as skipped");
  check(s.steps.find((x) => x.id === "sessions").state === "done", `sessions step: ${s.steps.find((x) => x.id === "sessions").detail.split("\n")[0]}`);
  await answer("Approval", "reject", "wrong user, ticket reopened");
  r = await pending;
  check(r.status === "rejected by human", `status = ${r.status}`);
  const a1 = await getUser(a);
  check(!a1.locked && !a1.validTo, `${a} unchanged`);

  console.log(`\n10. Leavers ${a} + ${b}, human approves`);
  pending = call("sap_deactivate_users", { usernames: [a, b], reason: "test: leavers, approve" });
  await nextPage();
  await answer("Ready to start", "start");
  s = await waitPrompt("Approval");
  check(s.prompt.text.includes(`${a} (`) && s.prompt.text.includes(`${b} (`) && s.prompt.text.includes("lock + end validity today"), "the approval lists both users and what will change");
  await answer("Approval", "approve");
  r = await pending;
  check(r.status === "done", `status = ${r.status}`);
  s = await state();
  console.log("  steps: " + s.steps.map((x) => `${x.label} [${x.state}]`).join(" -> "));
  check(s.steps.every((x) => x.state === "done"), "every step done");
  for (const before of leaversBefore) {
    const after = await getUser(before.username);
    check(after.lockReasons.includes("locked by administrator") && after.validTo === today && after.roles.length === before.roles.length,
      `${before.username}: locked, valid to ${after.validTo}, ${after.roles.length} role(s) kept`);
  }
  check(s.result.text.includes(a) && s.result.text.includes(b), "ticket reply shown on the page");

  console.log(`\n11. Same leavers again`);
  pending = call("sap_deactivate_users", { usernames: [a, b], reason: "test: twice" });
  await nextPage();
  await answer("Ready to start", "start");
  r = await pending;
  check(r.status === "nothing to do" && r.skipped.every((x) => x.why === "already deactivated"), `status = ${r.status}`);
}

async function roleTests() {
  console.log(`\n5. Add roles: role already assigned`);
  pending = call("sap_assign_roles", { username: TEMPLATE, roles: ["sap_br_purchaser"], reason: "test: already assigned" });
  await nextPage();
  s = await state();
  check(s.steps.length === 8 && s.steps.every((x) => x.state === "waiting"), "8 steps, all waiting before start");
  await answer("Ready to start", "start");
  r = await pending;
  s = await state();
  check(r.status === "nothing to do", `status = ${r.status}`);
  check(["approve", "assign", "verify"].every((id) => s.steps.find((x) => x.id === id).state === "skipped"), "approval, assign and verify shown as skipped");

  console.log(`\n6. Add roles: SoD conflict, human stops`);
  const before02 = names(await roleList("DEMO_02"));
  pending = call("sap_assign_roles", { username: "DEMO_02", roles: ["SAP_BR_PURCHASER", "SAP_BR_AP_ACCOUNTANT_PROCUREMT"], reason: "test: SoD conflict, stop" });
  await nextPage();
  await answer("Ready to start", "start");
  s = await waitPrompt("SoD conflict");
  check(s.prompt.text.includes("R03"), "the R03 conflict is shown on the page");
  await answer("SoD conflict", "stop");
  r = await pending;
  check(r.status === "stopped: SoD conflict", `status = ${r.status}`);
  check(names(await roleList("DEMO_02")) === before02, `DEMO_02 roles unchanged (${before02 || "none"})`);

  console.log(`\n7. Add ${NEW_ROLE} to ${ROLE_USER} (has ${rolesBefore.length} roles), human approves`);
  check(rolesBefore.length > 0 && !rolesBefore.some((x) => x.role === NEW_ROLE), `${ROLE_USER} has ${names(rolesBefore)}, not ${NEW_ROLE}`);
  pending = call("sap_assign_roles", { username: ROLE_USER, roles: [NEW_ROLE], validTo: "2026-12-31", reason: "test: add a role, keep the others" });
  await nextPage();
  await answer("Ready to start", "start");
  s = await waitPrompt("Approval");
  check(rolesBefore.every((x) => s.prompt.text.includes(x.role)), "the approval lists the roles that are kept");
  await answer("Approval", "approve");
  r = await pending;
  check(r.status === "done", `status = ${r.status}`);
  s = await state();
  console.log("  steps: " + s.steps.map((x) => `${x.label} [${x.state}]`).join(" -> "));
  check(s.steps.every((x) => x.state === "done"), "every step done");
  const after = await roleList(ROLE_USER);
  check(after.length === rolesBefore.length + 1 && rolesBefore.every((b) => after.some((x) => x.role === b.role && x.validTo === b.validTo)),
    `old roles kept with their dates, now: ${names(after)}`);
  check(after.some((x) => x.role === NEW_ROLE && x.validTo === "2026-12-31"), `${NEW_ROLE} valid to 2026-12-31`);
  check(s.result.text.includes(NEW_ROLE), "ticket reply shown on the page");
}

async function createTests() {
  check(!existedBefore, `${NEW} does not exist yet`);
  console.log("\n1. Human cancels before start");
  pending = call("sap_create_user_like", args);
  await nextPage();
  check((await fetch(page)).headers.get("content-type").startsWith("text/html"), "the workflow page is served");
  check((await fetch(page.replace(/\/[0-9a-f]+$/, "/wrongtoken"))).status === 404, "a wrong link gets nothing");
  s = await state();
  check(s.steps.length === 10 && s.steps.every((x) => x.state === "waiting"), "10 steps, all waiting before start");
  await answer("Ready to start", "cancel");
  r = await pending;
  check(r.status === "cancelled by human", `status = ${r.status}`);

  console.log("\n2. SoD conflict: override without justification is refused, then human stops");
  pending = call("sap_create_user_like", args);
  await nextPage();
  await answer("Ready to start", "start");
  s = await waitPrompt("SoD conflict");
  check(s.steps.find((x) => x.id === "sod").state === "warning", "SoD step shown as needing a decision");
  check(s.prompt.text.includes("R03"), "the R03 conflict is shown on the page");
  const refused = await answer("SoD conflict", "override", "ok");
  check(refused.status === 400, `override with a 2-character justification refused (HTTP ${refused.status})`);
  await answer("SoD conflict", "stop", "not without the controller's OK");
  r = await pending;
  check(r.status === "stopped: SoD conflict", `status = ${r.status}`);
  check(!(await exists(NEW)), `${NEW} was not created`);

  console.log("\n3. SoD conflict overridden with a justification, human approves");
  pending = call("sap_create_user_like", args);
  await nextPage();
  await answer("Ready to start", "start");
  await answer("SoD conflict", "override", "Temporary month-end cover, controller approved in ticket 4711");
  await answer("Approval", "approve", "ok for the demo");
  r = await pending;
  check(r.status === "done", `status = ${r.status}`);
  check(r.user?.roles.length === 2, `${NEW} created with roles: ${r.user?.roles.join(", ")}`);
  check(r.sodDecision?.override === true && r.sodDecision.justification.includes("4711"), "the override and its justification are in the result");
  s = await state();
  console.log("  steps: " + s.steps.map((x) => `${x.label} [${x.state}]`).join(" -> "));
  check(s.steps.every((x) => x.state === (x.id === "sod" ? "overridden" : "done")), "every step done, SoD step marked overridden");
  const first = await fetch(`${page}/secret`, { method: "POST" });
  const password = first.status === 200 ? (await first.json()).value : null;
  const second = await fetch(`${page}/secret`, { method: "POST" });
  check(password?.length > 0 && second.status === 410, "password can be shown once on the page, then it is gone");
  const log = (await call("sap_audit_log", { limit: 3 })).entries;
  check(password && !JSON.stringify(r).includes(password) && !JSON.stringify(log).includes(password), `password neither in the AI's answer nor in the audit log ("${r.initialPassword}")`);
  const entry = log.find((e) => e.requestId === r.requestId);
  check(entry?.status === "done" && entry.sodDecision?.override && entry.sodDecision.justification.includes("4711"), "audit log has the override, its author and justification");
  check(log.some((e) => e.status === "stopped: SoD conflict"), "audit log has the stopped request too");
}
