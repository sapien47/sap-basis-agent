// Read-only smoke test of the SOAP route: calls RFC_SYSTEM_INFO and BAPI_USER_GETLIST.
// Nothing is changed in SAP. Run: node --env-file=.env scripts/soap-smoke.mjs [USERNAME_PATTERN]
import { callRfc, tag, messages, plain, esc } from "../src/sap-soap.mjs";

// 1. System info
const info = await callRfc("RFC_SYSTEM_INFO");
console.log(`RFC_SYSTEM_INFO -> HTTP ${info.status}`);
if (info.status !== 200) console.log(plain(info.body).slice(0, 300));
else console.log(`  release: ${tag(info.body, "RFCSAPRL")[0]}, DB: ${tag(info.body, "RFCDBSYS")[0]}, OS: ${tag(info.body, "RFCOPSYS")[0]}`);

// 2. Users matching a pattern (default TEST*)
const pattern = process.argv[2] || "TEST*";
const list = await callRfc(
  "BAPI_USER_GETLIST",
  `<MAX_ROWS>50</MAX_ROWS><WITH_USERNAME>X</WITH_USERNAME>` +
    `<SELECTION_RANGE><item><PARAMETER>USERNAME</PARAMETER><SIGN>I</SIGN><OPTION>CP</OPTION><LOW>${esc(pattern)}</LOW></item></SELECTION_RANGE>` +
    `<USERLIST></USERLIST><RETURN></RETURN>`
);
console.log(`BAPI_USER_GETLIST (${pattern}) -> HTTP ${list.status}`);
if (list.status !== 200) console.log(plain(list.body).slice(0, 300));
else {
  console.log(`  users: ${tag(list.body, "USERNAME").join(", ") || "(none)"}`);
  console.log(`  rows: ${tag(list.body, "ROWS")[0]}; messages: ${messages(list.body).map((m) => m.message).join(" | ") || "-"}`);
}
