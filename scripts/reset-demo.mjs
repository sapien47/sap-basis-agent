// Puts the demo users of the managers' demo back to their starting state, after a dry run:
//   DEMO_08            does not exist           (demo 1 creates it)        -> deleted
//   DEMO_03            no SAP_BR_INVENTORY_MANAGER (demo 2 adds it)        -> that role removed, other roles kept
//   DEMO_06, DEMO_07   unlocked, no end date    (demo 3 deactivates them)  -> unlocked, end date cleared
//   DEMO_TPL_P2P       Purchaser + AP accountant (the SoD conflict)        -> only checked
// Calls the BAPIs directly, not through the agent, so these changes are not in the audit log.
// Usage: npm run reset-demo            (resets)
//        npm run reset-demo -- --check (only shows what is not ready, changes nothing)
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (!process.env.SAP_BASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);
const { callRfc, messages } = await import("../src/sap-soap.mjs");
const { getUser, setRoles, unlockUser } = await import("../src/users.mjs");

const checkOnly = process.argv.includes("--check");
const NEW_USER = "DEMO_08";
const ROLE_USER = "DEMO_03";
const ADDED_ROLE = "SAP_BR_INVENTORY_MANAGER";
const LEAVERS = ["DEMO_06", "DEMO_07"];
const TEMPLATE = "DEMO_TPL_P2P";
const TEMPLATE_ROLES = ["SAP_BR_PURCHASER", "SAP_BR_AP_ACCOUNTANT_PROCUREMT"];

const tryGet = async (u) => { try { return await getUser({ username: u }); } catch { return null; } };
const sapText = (body) => messages(body).map((m) => `[${m.type}] ${m.message}`).join(" ") || "no message";
let notReady = 0;
const line = (ok, text) => { console.log(`  ${ok ? "OK  " : "TODO"} ${text}`); if (!ok) notReady++; };

console.log(checkOnly ? "Checking the demo users (no changes):" : "Resetting the demo users:");

// Demo 1: DEMO_08 must not exist.
let u = await tryGet(NEW_USER);
if (!u) line(true, `${NEW_USER} does not exist`);
else if (checkOnly) line(false, `${NEW_USER} exists: will be deleted`);
else {
  const res = await callRfc("BAPI_USER_DELETE", `<USERNAME>${NEW_USER}</USERNAME><RETURN></RETURN>`);
  line(!(await tryGet(NEW_USER)), `${NEW_USER} deleted: ${sapText(res.body)}`);
}

// Demo 2: DEMO_03 has roles, but not the one the demo adds.
u = await tryGet(ROLE_USER);
if (!u) line(false, `${ROLE_USER} does not exist: create it first (scripts/create-demo-users.mjs)`);
else if (!u.roles.some((r) => r.role === ADDED_ROLE)) line(u.roles.length > 0, `${ROLE_USER} has ${u.roles.length} role(s), not ${ADDED_ROLE}`);
else if (checkOnly) line(false, `${ROLE_USER} has ${ADDED_ROLE}: will be removed`);
else {
  const keep = u.roles.filter((r) => r.role !== ADDED_ROLE);
  const res = await setRoles(ROLE_USER, keep.map((r) => ({ role: r.role, validFrom: r.validFrom, validTo: r.validTo })));
  const after = await tryGet(ROLE_USER);
  line(res.ok && after && !after.roles.some((r) => r.role === ADDED_ROLE) && after.roles.length === keep.length,
    `${ROLE_USER}: ${ADDED_ROLE} removed, ${keep.length} role(s) kept`);
}

// Demo 3: the leavers are active again: unlocked, no validity end.
for (const name of LEAVERS) {
  u = await tryGet(name);
  if (!u) { line(false, `${name} does not exist: create it first (scripts/create-demo-users.mjs)`); continue; }
  if (!u.locked && !u.validTo) { line(true, `${name} unlocked, no end date`); continue; }
  const state = `${u.locked ? `locked (${u.lockReasons.join(", ")})` : "unlocked"}, valid to ${u.validTo || "no end date"}`;
  if (checkOnly) { line(false, `${name} is ${state}: will be unlocked and its end date cleared`); continue; }
  if (u.locked) await unlockUser(name);
  // 0000-00-00 = no end date.
  if (u.validTo) await callRfc("BAPI_USER_CHANGE", `<USERNAME>${name}</USERNAME><LOGONDATA><GLTGB>0000-00-00</GLTGB></LOGONDATA><LOGONDATAX><GLTGB>X</GLTGB></LOGONDATAX><RETURN></RETURN>`);
  const after = await tryGet(name);
  line(after && !after.locked && !after.validTo, `${name} was ${state}, now ${after?.locked ? "still locked" : "unlocked"}, valid to ${after?.validTo || "no end date"}`);
}

// The SoD conflict of demo 1 needs both roles on the template.
u = await tryGet(TEMPLATE);
const missing = TEMPLATE_ROLES.filter((r) => !u?.roles.some((x) => x.role === r));
line(u && !missing.length, u ? `${TEMPLATE} has ${TEMPLATE_ROLES.join(" + ")}${missing.length ? `; missing: ${missing.join(", ")}` : ""}` : `${TEMPLATE} does not exist`);

console.log(notReady ? `\n${notReady} item(s) not ready.` : "\nReady for the demo.");
process.exit(notReady ? 1 : 0);
