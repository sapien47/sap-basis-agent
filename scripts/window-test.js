// Test of the approval window (APPROVAL_CHANNEL=window), against the real SAP system.
// The script plays the human: it reads the page's link from the server's stderr instead of
// opening a browser, then clicks Reject, or does nothing to test the timeout.
// Nothing is approved, so SAP is not changed. Touches DEMO_01 only.
// Usage: node --env-file=.env scripts/window-test.js

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures++;
};

// A client WITHOUT in-client dialogs: approval must come through the server's own window.
async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.js"],
    env: { ...process.env, APPROVAL_CHANNEL: "window", APPROVAL_NO_BROWSER: "1", ...extraEnv },
    stderr: "pipe",
  });
  const links = [];
  let waiting;
  transport.stderr.on("data", (chunk) => {
    const m = String(chunk).match(/\[approval\] (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+)/);
    if (m) waiting ? (waiting(m[1]), (waiting = null)) : links.push(m[1]);
  });
  const nextLink = () => (links.length ? Promise.resolve(links.shift()) : new Promise((r) => (waiting = r)));
  const client = new Client({ name: "window-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, nextLink };
}

const parse = (res) => {
  if (res.isError) throw new Error(res.content[0].text);
  return JSON.parse(res.content[0].text);
};
const lockedState = async (client, u) => parse(await client.callTool({ name: "sap_get_user", arguments: { username: u } })).locked;

// 1. The human opens the page and rejects.
console.log("1. Human opens the approval page and clicks Reject");
let { client, nextLink } = await connect();
const startLocked = await lockedState(client, "DEMO_01");
check(startLocked === false, "DEMO_01 is unlocked before the test");
let pending = client.callTool({ name: "sap_lock_users", arguments: { usernames: ["DEMO_01"], reason: "test: window reject" } });
const link = await nextLink();
const html = await (await fetch(link)).text();
check(html.includes("DEMO_01") && html.includes("test: window reject"), "page shows the user and the reason");
check((await fetch(link.replace(/\/[0-9a-f]+$/, "/wrong-token"))).status === 404, "a wrong link gets nothing (404)");
const post = await fetch(link, { method: "POST", body: new URLSearchParams({ decision: "reject", comment: "no ticket attached" }) });
check(post.ok && (await post.text()).includes("Rejected"), "page confirms the rejection");
let r = parse(await pending);
check(r.status === "rejected by human", `status = ${r.status}`);
check(!JSON.stringify(r).includes(link.split("/").pop()), "the agent never sees the page's secret link");
check((await fetch(link, { method: "POST", body: new URLSearchParams({ decision: "approve" }) }).catch(() => ({ ok: false }))).ok === false, "the page cannot be answered twice");
check((await lockedState(client, "DEMO_01")) === false, "DEMO_01 still unlocked");
let last = parse(await client.callTool({ name: "sap_audit_log", arguments: { limit: 1 } })).entries[0];
check(last.requestId === r.requestId && last.approval.answeredBy && last.approval.comment === "no ticket attached", "audit log: who rejected and their comment");
await client.close();

// 2. Nobody answers: the request expires.
console.log("\n2. Nobody answers within 3 seconds");
({ client, nextLink } = await connect({ APPROVAL_TIMEOUT_SECONDS: "3" }));
pending = client.callTool({ name: "sap_lock_users", arguments: { usernames: ["DEMO_01"], reason: "test: window timeout" } });
await nextLink();
r = parse(await pending);
check(r.status === "not approved: no human answer", `status = ${r.status}`);
check((await lockedState(client, "DEMO_01")) === false, "DEMO_01 still unlocked");
last = parse(await client.callTool({ name: "sap_audit_log", arguments: { limit: 1 } })).entries[0];
check(last.requestId === r.requestId && last.approval.answeredBy === null, "audit log names no human for it");
await client.close();

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
