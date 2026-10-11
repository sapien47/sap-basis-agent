// End-to-end check: starts the MCP server like an AI client would and calls every tool
// against the real SAP system. Read-only. Usage: npm test

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["src/server.js"], env: process.env });
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("Tools:", tools.map((t) => t.name).join(", "));

let failures = 0;
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) {
    failures++;
    console.log(`  FAIL ${name}: ${res.content[0].text}`);
    return null;
  }
  return JSON.parse(res.content[0].text);
}

const info = await call("sap_system_info");
if (info) console.log(`\nsap_system_info -> ${info.systemId} client ${info.client}, release ${info.release}, ${info.database}/${info.operatingSystem}`);

const list = await call("sap_list_users", { pattern: "DEMO*" });
if (list) console.log(`sap_list_users DEMO* -> ${list.count}: ${list.users.map((u) => `${u.username} (${u.fullName})`).join(", ")}`);

const user = await call("sap_get_user", { username: "demo_01" });
if (user) {
  console.log(`sap_get_user demo_01 -> ${user.fullName}, ${user.userType}, locked: ${user.locked}, roles: ${user.roles.length}, last changed ${user.lastChanged.date} by ${user.lastChanged.by}`);
  const leaked = JSON.stringify(user).match(/PWDSALTEDHASH|PASSCODE|BCODE/);
  console.log(`  no password fields in output: ${leaked ? "NO - LEAK" : "yes"}`);
  if (leaked) failures++;
}

const missing = await client.callTool({ name: "sap_get_user", arguments: { username: "NO_SUCH_USR" } });
console.log(`sap_get_user NO_SUCH_USR -> ${missing.isError ? "error as expected: " + missing.content[0].text : "UNEXPECTED: no error"}`);
if (!missing.isError) failures++;

const locked = await call("sap_locked_users");
if (locked) {
  console.log(`sap_locked_users -> ${locked.count} locked users`);
  for (const u of locked.users.slice(0, 5)) console.log(`  ${u.username}: ${u.lockReasons.join(", ")}`);
  // Cross-check: each listed user must show as locked in the detail BAPI too.
  let mismatches = 0;
  for (const u of locked.users.slice(0, 10)) {
    const d = await call("sap_get_user", { username: u.username });
    if (d && !d.locked) mismatches++;
  }
  console.log(`  cross-check of first ${Math.min(10, locked.count)} with sap_get_user: ${mismatches} mismatches`);
  failures += mismatches;
}

const sessions = await call("sap_logged_on_users");
if (sessions) console.log(`sap_logged_on_users -> ${sessions.sessions.length} sessions: ${[...new Set(sessions.sessions.map((s) => s.username))].join(", ")}`);

await client.close();
console.log(failures ? `\n${failures} problem(s)` : "\nAll tools OK");
process.exit(failures ? 1 : 0);
