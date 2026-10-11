// Test of sap_assign_roles against the real SAP system, through the in-client approval dialog with a
// scripted "human". Only the paths that change nothing: protected user, role already assigned,
// SoD conflict shown then rejected, client without dialogs. Reads DEMO_02 and DEMO_TPL_P2P.
// Usage: node --env-file=.env scripts/assign-test.js

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures++;
};

// A client that can show approval dialogs; `answers` is the queue of scripted human decisions.
const dialogs = [];
async function connect(withDialogs, answers = []) {
  const client = new Client({ name: "assign-test", version: "1.0.0" }, { capabilities: withDialogs ? { elicitation: {} } : {} });
  if (withDialogs) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      dialogs.push(req.params.message);
      const answer = answers.shift() ?? { action: "decline" };
      console.log("  [dialog shown to human]\n    " + req.params.message.split("\n").join("\n    "));
      console.log(`  [human answers] ${JSON.stringify(answer)}`);
      return answer;
    });
  }
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["src/server.js"], env: { ...process.env, APPROVAL_CHANNEL: "client" } }));
  return client;
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
  return JSON.parse(res.content[0].text);
}
const roleList = async (client, u) => (await call(client, "sap_get_user", { username: u })).roles.map((r) => r.role).sort().join();

let c = await connect(true, [{ action: "accept", content: { approve: false, comment: "SoD conflict" } }]);
check((await c.listTools()).tools.some((t) => t.name === "sap_assign_roles"), "sap_assign_roles is listed");

console.log("\n1. Protected user");
let r = await call(c, "sap_assign_roles", { username: "DDIC", roles: ["SAP_BR_PURCHASER"], reason: "test: protected" });
check(r.status === "not possible", `status = ${r.status}: ${r.problem}`);

console.log("\n2. Role already assigned");
r = await call(c, "sap_assign_roles", { username: "DEMO_TPL_P2P", roles: ["sap_br_purchaser"], reason: "test: already assigned" });
check(r.status === "nothing to do", `status = ${r.status}`);

console.log("\n3. Two roles in SoD conflict, human rejects");
const before = await roleList(c, "DEMO_02");
r = await call(c, "sap_assign_roles", {
  username: "DEMO_02", roles: ["SAP_BR_PURCHASER", "SAP_BR_AP_ACCOUNTANT_PROCUREMT"], reason: "test: SoD conflict, reject",
});
check(r.status === "rejected by human", `status = ${r.status}`);
check(r.sod.conflicts.some((x) => x.startsWith("R03")), `SoD conflict reported: ${r.sod.conflicts.join("; ")}`);
check(dialogs.at(-1)?.includes("R03 High"), "the conflict was shown in the approval dialog");
check((await roleList(c, "DEMO_02")) === before, `DEMO_02 roles unchanged (${before || "none"})`);
const last = (await call(c, "sap_audit_log", { limit: 1 })).entries[0];
check(last.requestId === r.requestId && last.action === "assign roles", "the rejection is in the audit log");
await c.close();

console.log("\n4. Client that cannot show approval dialogs");
c = await connect(false);
r = await call(c, "sap_assign_roles", { username: "DEMO_02", roles: ["SAP_BR_PURCHASER"], reason: "test: no dialog" });
check(r.status === "refused: no approval channel", `status = ${r.status}`);
check((await roleList(c, "DEMO_02")) === before, "DEMO_02 roles unchanged");
await c.close();

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
