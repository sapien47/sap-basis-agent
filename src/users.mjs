// Read-only SAP user administration functions, built on standard BAPIs / RFC function modules.
// Each function returns plain JSON with hand-picked fields: password hashes and host addresses
// that SAP also returns are never passed on.
import { callRfc, struct, table, messages, plain, esc } from "./sap-soap.mjs";

// Call a function module; throw a readable error on HTTP/SOAP failure.
async function rfc(fm, innerXml) {
  const { status, body } = await callRfc(fm, innerXml);
  if (status !== 200) throw new Error(`${fm} failed (HTTP ${status}): ${plain(body).slice(0, 300)}`);
  return body;
}

const USER_TYPES = { A: "Dialog", B: "System", C: "Communication", L: "Reference", S: "Service" };

// Local calendar date as YYYY-MM-DD, optionally shifted by some days. Local, not UTC:
// a run in the evening must not produce tomorrow's date.
export function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-CA");
}
const date = (d) => (!d || d.startsWith("0000") ? null : d);
const username = (u) => esc(String(u).trim().toUpperCase());

// Turn the ISLOCKED structure (L = locked, U = unlocked) into readable reasons.
function lockReasons(l) {
  if (!l) return [];
  const reasons = [];
  if (l.LOCAL_LOCK === "L") reasons.push("locked by administrator");
  if (l.GLOB_LOCK === "L") reasons.push("locked globally (central user administration)");
  if (l.WRNG_LOGON === "L") reasons.push("locked after too many failed logons");
  return reasons;
}

export async function systemInfo() {
  const s = struct(await rfc("RFC_SYSTEM_INFO", ""), "RFCSI_EXPORT") || {};
  return {
    systemId: s.RFCSYSID,
    client: process.env.SAP_CLIENT,
    release: s.RFCSAPRL,
    kernelRelease: s.RFCKERNRL,
    database: s.RFCDBSYS,
    operatingSystem: s.RFCOPSYS,
    timeZone: s.RFCTZONE,
  };
}

function selection(conditions) {
  return conditions
    .map(([parameter, field, option, low]) =>
      `<item><PARAMETER>${parameter}</PARAMETER><FIELD>${field}</FIELD><SIGN>I</SIGN>` +
      `<OPTION>${option}</OPTION><LOW>${esc(low)}</LOW></item>`)
    .join("");
}

async function getList(conditions, maxRows) {
  const body = await rfc(
    "BAPI_USER_GETLIST",
    `<MAX_ROWS>${maxRows}</MAX_ROWS><WITH_USERNAME>X</WITH_USERNAME>` +
      `<SELECTION_RANGE>${selection(conditions)}</SELECTION_RANGE><USERLIST></USERLIST><RETURN></RETURN>`
  );
  const errors = messages(body).filter((m) => m.type === "E" || m.type === "A");
  if (errors.length) throw new Error(errors.map((m) => m.message).join("; "));
  return table(body, "USERLIST").map((u) => ({ username: u.USERNAME, fullName: u.FULLNAME || null }));
}

export async function listUsers({ pattern = "*", maxRows = 50 } = {}) {
  const users = await getList([["USERNAME", "", "CP", pattern.toUpperCase()]], maxRows);
  return { pattern: pattern.toUpperCase(), count: users.length, truncated: users.length >= maxRows, users };
}

export async function getUser({ username: name }) {
  const body = await rfc(
    "BAPI_USER_GET_DETAIL",
    `<USERNAME>${username(name)}</USERNAME><ACTIVITYGROUPS></ACTIVITYGROUPS><RETURN></RETURN>`
  );
  const errors = messages(body).filter((m) => m.type === "E" || m.type === "A");
  if (errors.length) throw new Error(errors.map((m) => m.message).join("; "));
  const logon = struct(body, "LOGONDATA") || {};
  const address = struct(body, "ADDRESS") || {};
  const changed = struct(body, "LASTMODIFIED") || {};
  const reasons = lockReasons(struct(body, "ISLOCKED"));
  return {
    username: String(name).trim().toUpperCase(),
    fullName: address.FULLNAME || null,
    userType: USER_TYPES[logon.USTYP] || logon.USTYP || null,
    userTypeCode: logon.USTYP || null,
    userGroup: logon.CLASS || null,
    validFrom: date(logon.GLTGV),
    validTo: date(logon.GLTGB),
    locked: reasons.length > 0,
    lockReasons: reasons,
    roles: table(body, "ACTIVITYGROUPS").map((r) => ({
      role: r.AGR_NAME, text: r.AGR_TEXT || null, validFrom: date(r.FROM_DAT), validTo: date(r.TO_DAT),
    })),
    lastChanged: { by: changed.MODIFIER || null, date: date(changed.MODDATE), time: changed.MODTIME || null },
  };
}

// Users with any kind of lock. One query per lock type, merged, so each user shows all its reasons.
export async function lockedUsers({ pattern = "*", maxRows = 200 } = {}) {
  const kinds = [
    ["LOCAL_LOCK", "locked by administrator"],
    ["GLOB_LOCK", "locked globally (central user administration)"],
    ["WRNG_LOGON", "locked after too many failed logons"],
  ];
  const byUser = new Map();
  for (const [field, reason] of kinds) {
    const users = await getList(
      [["USERNAME", "", "CP", pattern.toUpperCase()], ["ISLOCKED", field, "EQ", "L"]],
      maxRows
    );
    for (const u of users) {
      if (!byUser.has(u.username)) byUser.set(u.username, { ...u, lockReasons: [] });
      byUser.get(u.username).lockReasons.push(reason);
    }
  }
  const users = [...byUser.values()].sort((a, b) => a.username.localeCompare(b.username));
  return { pattern: pattern.toUpperCase(), count: users.length, users };
}

// ---------------------------------------------------------------- write BAPIs
// These change SAP. They are only called from actions.mjs, after a human approved.

function bapiResult(fm, body) {
  const msgs = messages(body);
  return { bapi: fm, ok: !msgs.some((m) => m.type === "E" || m.type === "A"), messages: msgs };
}

export async function lockUser(name) {
  return bapiResult("BAPI_USER_LOCK", await rfc("BAPI_USER_LOCK", `<USERNAME>${username(name)}</USERNAME><RETURN></RETURN>`));
}

export async function unlockUser(name) {
  return bapiResult("BAPI_USER_UNLOCK", await rfc("BAPI_USER_UNLOCK", `<USERNAME>${username(name)}</USERNAME><RETURN></RETURN>`));
}

// The initial password SAP generated (GENERATE_PWD), or null.
const generatedPassword = (body) => struct(body, "GENERATED_PASSWORD")?.BAPIPWD || null;

// Create a dialog user like a template: same user type, user group, validity end and roles.
// SAP generates the initial password. It is returned separately, for the human only:
// the caller must never put it in the audit log or the AI's answer.
export async function createUser({ newUsername, template, firstName, lastName }) {
  const today = localDate();
  const logon =
    `<USTYP>${esc(template.userTypeCode)}</USTYP>` +
    (template.userGroup ? `<CLASS>${esc(template.userGroup)}</CLASS>` : "") +
    `<GLTGV>${today}</GLTGV>` +
    (template.validTo ? `<GLTGB>${template.validTo}</GLTGB>` : "");
  const body = await rfc(
    "BAPI_USER_CREATE1",
    `<USERNAME>${username(newUsername)}</USERNAME><LOGONDATA>${logon}</LOGONDATA>` +
      `<ADDRESS><FIRSTNAME>${esc(firstName)}</FIRSTNAME><LASTNAME>${esc(lastName)}</LASTNAME></ADDRESS>` +
      `<GENERATE_PWD>X</GENERATE_PWD><RETURN></RETURN>`
  );
  const created = bapiResult("BAPI_USER_CREATE1", body);
  const password = created.ok ? generatedPassword(body) : null;
  const steps = [created];
  if (created.ok && template.roles.length) {
    steps.push(await setRoles(newUsername, template.roles.map((r) => ({ role: r.role, validFrom: today, validTo: r.validTo || "9999-12-31" }))));
  }
  return { ok: steps.every((s) => s.ok), steps, password };
}

// Set the user's complete role list: [{ role, validFrom, validTo }]. BAPI_USER_ACTGROUPS_ASSIGN
// replaces the whole list, so to add a role the caller must pass the roles to keep as well.
export async function setRoles(name, roles) {
  const items = roles
    .map((r) => `<item><AGR_NAME>${esc(r.role)}</AGR_NAME><FROM_DAT>${esc(r.validFrom)}</FROM_DAT><TO_DAT>${esc(r.validTo)}</TO_DAT></item>`)
    .join("");
  return bapiResult(
    "BAPI_USER_ACTGROUPS_ASSIGN",
    await rfc("BAPI_USER_ACTGROUPS_ASSIGN", `<USERNAME>${username(name)}</USERNAME><ACTIVITYGROUPS>${items}</ACTIVITYGROUPS><RETURN></RETURN>`)
  );
}

// Change the validity end and/or let SAP generate a new initial password (the user must change it
// at the next logon). Same rule as createUser: the password is for the human only.
export async function changeUser(name, { validTo = null, newPassword = false }) {
  const body = await rfc(
    "BAPI_USER_CHANGE",
    `<USERNAME>${username(name)}</USERNAME>` +
      (validTo ? `<LOGONDATA><GLTGB>${esc(validTo)}</GLTGB></LOGONDATA><LOGONDATAX><GLTGB>X</GLTGB></LOGONDATAX>` : "") +
      (newPassword ? `<GENERATE_PWD>X</GENERATE_PWD><PASSWORDX><BAPIPWD>X</BAPIPWD></PASSWORDX>` : "") +
      `<RETURN></RETURN>`
  );
  const result = bapiResult("BAPI_USER_CHANGE", body);
  return { result, password: newPassword && result.ok ? generatedPassword(body) : null };
}

// Sessions on the application server that answers the call (not all servers of a multi-server system).
export async function loggedOnUsers() {
  const body = await rfc("TH_USER_LIST", "<LIST></LIST><USRLIST></USRLIST>");
  const sessions = table(body, "USRLIST").map((s) => ({
    username: s.BNAME, client: s.MANDT, transaction: s.TCODE || null, lastActivity: s.ZEIT || null,
    sessions: Number(s.EXTMODI) || null, type: s.TYPE || null,
  }));
  return {
    note: "Sessions on one application server only.",
    count: sessions.length,
    sessions: sessions.filter((s) => s.username),
  };
}
