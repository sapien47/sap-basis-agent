// End-to-end test of the write tools and their governance, against the real SAP system.
// A scripted "human" answers the approval dialogs (in-client channel). Touches DEMO_* users only.
// Leaves DEMO_01..03 unlocked; creates DEMO_04 if it does not exist yet.
// Usage: node --env-file=.env scripts/write-test.js

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures++;
};

// A client that can show approval dialogs; `answers` is the queue of scripted human decisions.
async function connect(withDialogs, answers = []) {
  const client = new Client(
    { name: "write-test", version: "1.0.0" },
    { capabilities: withDialogs ? { elicitation: {} } : {} }
  );
  if (withDialogs) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
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

const lockedState = async (client, u) => (await call(client, "sap_get_user", { username: u })).locked;
const approve = (comment) => ({ action: "accept", content: comment ? { approve: true, comment } : { approve: true } });
const reject = (comment) => ({ action: "accept", content: comment ? { approve: false, comment } : { approve: false } });

// 0. Start from a known state: DEMO_01 and DEMO_02 unlocked (through the normal approved path).
console.log("0. Reset: make sure DEMO_01 and DEMO_02 are unlocked");
{
  const c0 = await connect(true, [approve("test reset")]);
  const r0 = await call(c0, "sap_unlock_users", { usernames: ["DEMO_01", "DEMO_02"], reason: "test reset" });
  console.log(`  ${r0.status}`);
  await c0.close();
}

// 1. Client without approval dialogs: must refuse.
console.log("\n1. Client that cannot show approval dialogs");
let c = await connect(false);
let r = await call(c, "sap_lock_users", { usernames: ["DEMO_01"], reason: "test: no dialog" });
check(r.status === "refused: no approval channel", `status = ${r.status}`);
check((await lockedState(c, "DEMO_01")) === false, "DEMO_01 still unlocked");
await c.close();

// 2. Human rejects.
console.log("\n2. Human rejects");
c = await connect(true, [reject("not without a ticket")]);
r = await call(c, "sap_lock_users", { usernames: ["DEMO_01"], reason: "test: reject" });
check(r.status === "rejected by human", `status = ${r.status}`);
check((await lockedState(c, "DEMO_01")) === false, "DEMO_01 still unlocked");
await c.close();

// 2a. Client answers "decline" by itself (no form submitted): no change, and not blamed on the operator.
console.log("\n2a. AI client returns 'decline' without a human answer");
c = await connect(true, [{ action: "decline" }]);
r = await call(c, "sap_lock_users", { usernames: ["DEMO_01"], reason: "test: client decline" });
check(r.status === "not approved: no human answer", `status = ${r.status}`);
check((await lockedState(c, "DEMO_01")) === false, "DEMO_01 still unlocked");
const declined = (await call(c, "sap_audit_log", { limit: 1 })).entries[0];
check(declined.requestId === r.requestId && declined.approval.answeredBy === null, "audit log names no human for it");
await c.close();

// 2b. Broken dialog answer: no change, but logged.
console.log("\n2b. Approval dialog returns an invalid answer");
c = await connect(true, [{ action: "accept", content: { approve: true, comment: undefined } }]);
r = await call(c, "sap_lock_users", { usernames: ["DEMO_01"], reason: "test: broken dialog" });
check(r.status === "not approved: dialog failed", `status = ${r.status}`);
check((await lockedState(c, "DEMO_01")) === false, "DEMO_01 still unlocked");
const last = (await call(c, "sap_audit_log", { limit: 1 })).entries[0];
check(last.requestId === r.requestId, "the failed request is in the audit log");
await c.close();

// 3. Human approves a batch lock; non-existent and protected users are skipped.
console.log("\n3. Human approves locking DEMO_01 + DEMO_02 (DEMO_99 and DDIC must be skipped)");
c = await connect(true, [approve("ok, test")]);
r = await call(c, "sap_lock_users", { usernames: ["DEMO_01", "demo_02", "DEMO_99", "DDIC"], reason: "test: approved lock" });
console.log("  result:", JSON.stringify(r.results), "| skipped:", JSON.stringify(r.skipped));
check(r.status === "done", `status = ${r.status}`);
check(r.results?.length === 2 && r.results.every((x) => x.verified), "both locked and verified");
check(r.skipped?.map((s) => s.username).sort().join() === "DDIC,DEMO_99", "DEMO_99 and DDIC skipped");
const locked = await call(c, "sap_locked_users", { pattern: "DEMO*" });
check(locked.users.map((u) => u.username).join() === "DEMO_01,DEMO_02", `locked DEMO users: ${locked.users.map((u) => u.username).join(", ")}`);

// 4. Locking again: nothing to do, no dialog.
console.log("\n4. Lock DEMO_01 again (already locked)");
r = await call(c, "sap_lock_users", { usernames: ["DEMO_01"], reason: "test: twice" });
check(r.status === "nothing to do", `status = ${r.status}`);
await c.close();

// 5. Human approves unlocking.
console.log("\n5. Human approves unlocking DEMO_01 + DEMO_02");
c = await connect(true, [approve()]);
r = await call(c, "sap_unlock_users", { usernames: ["DEMO_01", "DEMO_02"], reason: "test: approved unlock" });
check(r.status === "done" && r.results.every((x) => x.verified), `status = ${r.status}, verified`);
check((await lockedState(c, "DEMO_01")) === false && (await lockedState(c, "DEMO_02")) === false, "DEMO_01 and DEMO_02 unlocked");

// 6. Create from template.
console.log("\n6. Create DEMO_04 like DEMO_01");
const exists = await c.callTool({ name: "sap_get_user", arguments: { username: "DEMO_04" } });
if (!exists.isError) {
  console.log("  DEMO_04 exists already, checking the 'already exists' path instead");
  r = await call(c, "sap_create_user_like", { newUsername: "DEMO_04", templateUsername: "DEMO_01", firstName: "Demo", lastName: "User 04", reason: "test" });
  check(r.status === "not possible", `status = ${r.status}: ${r.problem}`);
} else {
  await c.close();
  c = await connect(true, [approve("new joiner, test")]);
  r = await call(c, "sap_create_user_like", { newUsername: "DEMO_04", templateUsername: "DEMO_01", firstName: "Demo", lastName: "User 04", reason: "test: new joiner like DEMO_01" });
  console.log("  result:", JSON.stringify(r));
  check(r.status === "done", `status = ${r.status}`);
  check(!JSON.stringify(r).match(/PASSWORD|PWD/i), "no password in the answer");
}
await c.close();

// 7. Audit log.
console.log("\n7. Audit log");
c = await connect(false);
const log = await call(c, "sap_audit_log", { limit: 10 });
for (const e of log.entries.slice().reverse()) console.log(`  ${e.time} ${e.requestId} ${e.action} -> ${e.status} (reason: ${e.reason})`);
check(log.entries.length >= 6, `${log.total} entries in total`);
await c.close();

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
