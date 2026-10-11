// Call one tool of the MCP server from the command line, like an AI client would.
// Write tools open the approval page in the browser.
// Usage: node scripts/call-tool.mjs <tool> '<json arguments>'
//   e.g. node scripts/call-tool.mjs sap_get_user '{"username":"DEMO_02"}'

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, json = "{}"] = process.argv.slice(2);
if (!tool) {
  console.error("Usage: node scripts/call-tool.mjs <tool> '<json arguments>'");
  process.exit(2);
}

const client = new Client({ name: "call-tool", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["src/server.js"], env: process.env }));
// Approvals can take minutes; do not let the client give up after the default 60 s.
const res = await client.callTool({ name: tool, arguments: JSON.parse(json) }, undefined, { timeout: 10 * 60 * 1000 });
console.log(res.content.map((c) => c.text).join("\n"));
await client.close();
process.exit(res.isError ? 1 : 0);
