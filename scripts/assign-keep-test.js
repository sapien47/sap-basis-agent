// Live test of the "add a role to a user who already has roles" path of sap_assign_roles, on the
// real SAP system, through the in-client approval dialog with a scripted "human" who approves.
// Checks that the existing roles survive (BAPI_USER_ACTGROUPS_ASSIGN replaces the whole list), with
// a second opinion read straight from table AGR_USERS by scripts/user_roles.py. Restores the
// user's original roles at the end, even if a check fails. Changes DEMO_03 only.
// Usage: node --env-file=.env scripts/assign-keep-test.js

import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { setRoles } from "../src/users.mjs";

const USER = "DEMO_03";
const NEW_ROLE = "SAP_BR_INVENTORY_MANAGER";
const NEW_ROLE_END = "2026-12-31";

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures++;
};

const dialogs = [];
const client = new Client({ name: "assign-keep-test", version: "1.0.0" }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  dialogs.push(req.params.message);
  const answer = { action: "accept", content: { approve: true, comment: "test: approved by script" } };
  console.log("  [dialog shown to human]\n    " + req.params.message.split("\n").join("\n    "));
  console.log(`  [human answers] ${JSON.stringify(answer)}`);
  return answer;
});
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["src/server.js"], env: { ...process.env, APPROVAL_CHANNEL: "client" } }));

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
  return JSON.parse(res.content[0].text);
}
const viaAgent = async () => (await call("sap_get_user", { username: USER })).roles;
const viaTable = () => JSON.parse(execFileSync("python", ["scripts/user_roles.py", USER], { encoding: "utf8" })).roles;
const names = (roles) => roles.map((r) => r.role).sort().join(", ");
const show = (label, roles) => console.log(`  ${label}: ${roles.map((r) => `${r.role} (${r.validFrom} to ${r.validTo})`).join(", ") || "none"}`);

const before = await viaAgent();
try {
  console.log(`\n1. Before: ${USER}`);
  show("roles (agent, BAPI)", before);
  show("roles (table AGR_USERS)", viaTable());
  check(before.length > 0, `${USER} already has ${before.length} role(s)`);
  check(!before.some((r) => r.role === NEW_ROLE), `${USER} does not have ${NEW_ROLE} yet`);
  check(names(viaTable()) === names(before), "agent and table agree");

  console.log(`\n2. Add ${NEW_ROLE} (valid to ${NEW_ROLE_END}), human approves`);
  const r = await call("sap_assign_roles", { username: USER, roles: [NEW_ROLE], validTo: NEW_ROLE_END, reason: "test: add a role, keep the others" });
  check(r.status === "done", `status = ${r.status}`);
  check(before.every((b) => dialogs.at(-1)?.includes(b.role)), "the approval dialog listed the roles that are kept");
  console.log(`  ticket reply: ${r.ticketReply}`);

  console.log("\n3. After");
  const after = await viaAgent();
  const table = viaTable();
  show("roles (agent, BAPI)", after);
  show("roles (table AGR_USERS)", table);
  for (const roles of [after, table]) {
    const src = roles === after ? "agent" : "table";
    check(roles.length === before.length + 1, `${src}: ${roles.length} roles = ${before.length} before + 1`);
    check(roles.some((x) => x.role === NEW_ROLE && x.validTo === NEW_ROLE_END), `${src}: ${NEW_ROLE} present, valid to ${NEW_ROLE_END}`);
    check(before.every((b) => roles.some((x) => x.role === b.role && x.validFrom === b.validFrom && x.validTo === b.validTo)),
      `${src}: every old role kept with the same dates`);
  }

  console.log("\n4. Same request again");
  const again = await call("sap_assign_roles", { username: USER, roles: [NEW_ROLE], reason: "test: repeat" });
  check(again.status === "nothing to do", `status = ${again.status} (${again.skipped?.map((s) => s.why).join(", ")})`);

  console.log("\n5. Audit log");
  const log = (await call("sap_audit_log", { limit: 2 })).entries;
  check(log.some((e) => e.requestId === r.requestId && e.status === "done" && e.verified), "the approved change is in the audit log, marked verified");
} finally {
  console.log(`\n6. Restore ${USER} to its original roles`);
  const res = await setRoles(USER, before.map((b) => ({ role: b.role, validFrom: b.validFrom, validTo: b.validTo })));
  const restored = viaTable();
  check(res.ok && names(restored) === names(before), `restored: ${names(restored)}`);
  await client.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
