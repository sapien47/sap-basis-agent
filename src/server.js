#!/usr/bin/env node
// MCP server giving an AI agent SAP Basis user administration tools, backed by standard BAPIs
// called over SOAP/HTTP (/sap/bc/soap/rfc). Runs locally over stdio.
// Read tools run directly. Write tools (lock, unlock, create) only run after a human approved them
// in an approval page the server opens in the browser (or in the AI client, APPROVAL_CHANNEL=client),
// and every write request is recorded in logs/audit.jsonl.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { systemInfo, listUsers, getUser, lockedUsers, loggedOnUsers } from "./users.mjs";
import { lockUsers, unlockUsers, createUserLike, assignRoles, deactivateUsers, reactivateUser, diagnoseAccess } from "./actions.mjs";
import { readAudit } from "./governance.mjs";
import { checkSod } from "./sod.mjs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Load the project's .env (connection settings) wherever the server is started from.
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (!process.env.SAP_BASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

const server = new McpServer({ name: "sap-basis-agent", version: "0.1.0" });

// Every tool returns JSON text; SAP errors come back as readable messages.
function respond(fn) {
  return async (args) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await fn(args), null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  };
}

const usernameSchema = z.string().min(1).max(12).describe("SAP user name, e.g. DEMO_01");
const patternSchema = z.string().max(12).optional().describe("User name pattern with * wildcards, e.g. DEMO* (default *)");

server.registerTool(
  "sap_system_info",
  {
    title: "SAP system info",
    description: "Which SAP system and client the tools are connected to: system ID, client, release, kernel, database, OS, time zone.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  respond(systemInfo)
);

server.registerTool(
  "sap_list_users",
  {
    title: "List SAP users",
    description: "List user names (and full names) matching a pattern. Read-only.",
    inputSchema: {
      pattern: patternSchema,
      maxRows: z.number().int().min(1).max(500).optional().describe("Maximum users returned (default 50)"),
    },
    annotations: { readOnlyHint: true },
  },
  respond(listUsers)
);

server.registerTool(
  "sap_get_user",
  {
    title: "Get SAP user details",
    description:
      "Details of one SAP user: full name, user type, user group, validity dates, lock status with reasons, assigned roles, and who changed it last. Read-only.",
    inputSchema: { username: usernameSchema },
    annotations: { readOnlyHint: true },
  },
  respond(getUser)
);

server.registerTool(
  "sap_locked_users",
  {
    title: "Locked SAP users",
    description:
      "Users that are currently locked, with the reason (by administrator, globally, or after too many failed logons). Optional name pattern. Read-only.",
    inputSchema: {
      pattern: patternSchema,
      maxRows: z.number().int().min(1).max(1000).optional().describe("Maximum users per lock type (default 200)"),
    },
    annotations: { readOnlyHint: true },
  },
  respond(lockedUsers)
);

server.registerTool(
  "sap_logged_on_users",
  {
    title: "Logged-on SAP users",
    description:
      "Who is logged on right now (like SM04): user, client, current transaction, last activity. Covers the application server that answers, not every server. Read-only.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  respond(loggedOnUsers)
);

// ------------------------------------------------------------- write tools
const reasonSchema = z
  .string()
  .min(3)
  .describe("Why this change is requested, in the requester's words (e.g. 'helpdesk ticket 4711: user called, forgot password')");
const replyLanguageSchema = z.enum(["en", "fr"]).optional().describe("Language of the ticket reply (default en)");
const approvalNote =
  " Changes SAP. A human must approve the request in a dialog before anything happens; the result is verified and written to the audit log.";

server.registerTool(
  "sap_lock_users",
  {
    title: "Lock SAP users",
    description: "Lock one or more SAP users (administrator lock), with one approval for the whole list." + approvalNote,
    inputSchema: { usernames: z.array(usernameSchema).min(1).max(20), reason: reasonSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  respond((args) => lockUsers(server.server, args))
);

server.registerTool(
  "sap_unlock_users",
  {
    title: "Unlock SAP users",
    description:
      "Unlock one or more SAP users (administrator lock and lock after failed logons), with one approval for the whole list." + approvalNote,
    inputSchema: { usernames: z.array(usernameSchema).min(1).max(20), reason: reasonSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  respond((args) => unlockUsers(server.server, args))
);

server.registerTool(
  "sap_create_user_like",
  {
    title: "Create SAP user from a template",
    description:
      "For 'SAP account creation' tickets: create a new dialog user copied from a template user (e.g. a colleague with the same job): same user type, user group, validity end and roles. Runs as a live workflow page in the browser: the human starts it and follows each step. The template's roles are SoD-checked first; on a conflict the human must stop the request or override it with a justification, which is logged. The tool returns only when the workflow has ended, which can take minutes. SAP generates the initial password, which is shown only to the human in the browser, never to the AI. Returns a ready-to-paste ticket reply." +
      approvalNote,
    inputSchema: {
      newUsername: usernameSchema,
      templateUsername: usernameSchema,
      firstName: z.string().min(1).max(40),
      lastName: z.string().min(1).max(40),
      reason: reasonSchema,
      replyLanguage: replyLanguageSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  respond((args) => createUserLike(server.server, args))
);

server.registerTool(
  "sap_assign_roles",
  {
    title: "Assign roles to an SAP user",
    description:
      "For 'access request' tickets: add one or more roles to an existing user; its current roles are kept and roles already assigned are skipped. " +
      "Runs as a live workflow page in the browser: the human starts it and follows each step. " +
      "The user's current roles plus the requested ones are SoD-checked first; on a conflict the human must stop the request or override it with a justification, which is logged. " +
      "The tool returns only when the workflow has ended, which can take minutes. " +
      "To create a user with only some roles: sap_create_user_like from a template without roles, then this tool. Returns a ready-to-paste ticket reply." +
      approvalNote,
    inputSchema: {
      username: usernameSchema,
      roles: z.array(z.string().min(1).max(30)).min(1).max(10).describe("Roles to add, e.g. SAP_BR_PURCHASER"),
      validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Role validity end, YYYY-MM-DD (default unlimited)"),
      reason: reasonSchema,
      replyLanguage: replyLanguageSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  respond((args) => assignRoles(server.server, args))
);

server.registerTool(
  "sap_deactivate_users",
  {
    title: "Deactivate SAP users (leavers)",
    description:
      "For 'SAP account deactivate' tickets (employee left): lock the users and end their validity today, with one approval for the whole list. Roles are kept for the audit trail. Runs as a live workflow page in the browser: the human starts it and follows each step, including whether a leaver is still logged on. The tool returns only when the workflow has ended, which can take minutes. Returns a ready-to-paste ticket reply." +
      approvalNote,
    inputSchema: { usernames: z.array(usernameSchema).min(1).max(20), reason: reasonSchema, replyLanguage: replyLanguageSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  respond((args) => deactivateUsers(server.server, args))
);

server.registerTool(
  "sap_reactivate_user",
  {
    title: "Reactivate or extend an SAP user",
    description:
      "For 'account reactivation' and 'access extension' tickets: unlock the user if locked, extend its validity, and optionally let SAP generate a new initial password, which is shown only to the human in the browser, never to the AI. " +
      "For a pure validity extension set newPassword to false. Returns a ready-to-paste ticket reply." +
      approvalNote,
    inputSchema: {
      username: usernameSchema,
      validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
        .describe("New validity end, YYYY-MM-DD. Default: unchanged, or 90 days from today if the account has expired"),
      newPassword: z.boolean().optional().describe("Generate a new initial password (default true)"),
      reason: reasonSchema,
      replyLanguage: replyLanguageSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  respond((args) => reactivateUser(server.server, args))
);

server.registerTool(
  "sap_diagnose_access",
  {
    title: "Diagnose 'I can't access SAP'",
    description:
      "For 'problème d'accès SAP' / access incidents: checks one user for the usual causes (does not exist, locked and why, expired or not yet valid, wrong user type, no or expired roles) " +
      "and returns each finding with the fix the agent can propose, plus a ready-to-paste ticket reply. Read-only.",
    inputSchema: { username: usernameSchema, replyLanguage: replyLanguageSchema },
    annotations: { readOnlyHint: true },
  },
  respond(diagnoseAccess)
);

server.registerTool(
  "sap_check_sod",
  {
    title: "Segregation of duties (SoD) check",
    description:
      "Before creating a user like a template or assigning roles: combines the current roles of the given users with the requested roles " +
      "and reports risky combinations one person should not hold (e.g. create purchase orders + enter supplier invoices), with the roles and apps causing each. " +
      "Examples: new user like DEMO_01 -> usernames [DEMO_01]; give DEMO_03 a role -> usernames [DEMO_03] + roles [the role]. " +
      "Roles it cannot see inside are listed as not checked. Read-only; sample rule set, not SAP GRC.",
    inputSchema: {
      usernames: z.array(usernameSchema).max(5).optional().describe("Users whose current roles are included (target and/or template user)"),
      roles: z.array(z.string().min(1).max(30)).max(30).optional().describe("Requested roles, e.g. SAP_BR_PURCHASER"),
    },
    annotations: { readOnlyHint: true },
  },
  respond(checkSod)
);

server.registerTool(
  "sap_audit_log",
  {
    title: "Audit log of agent actions",
    description:
      "Most recent write requests handled by this agent, newest first: who was at the keyboard, the reason, the human decision, the BAPIs called and the verified result. Read-only.",
    inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Number of entries (default 20)") },
    annotations: { readOnlyHint: true },
  },
  respond(readAudit)
);

await server.connect(new StdioServerTransport());
