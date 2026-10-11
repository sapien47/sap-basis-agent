// One-off setup: creates the demo users DEMO_01..DEMO_03 (dialog users, system-generated
// password that is never printed), then reads them back to confirm.
// Run: node --env-file=.env scripts/create-demo-users.mjs
import { callRfc, tag, messages, plain } from "../src/sap-soap.mjs";

const users = ["DEMO_01", "DEMO_02", "DEMO_03"];

for (const u of users) {
  const nr = u.slice(-2);
  const res = await callRfc(
    "BAPI_USER_CREATE1",
    `<USERNAME>${u}</USERNAME>` +
      `<LOGONDATA><USTYP>A</USTYP></LOGONDATA>` +
      `<ADDRESS><FIRSTNAME>Demo</FIRSTNAME><LASTNAME>User ${nr}</LASTNAME></ADDRESS>` +
      `<GENERATE_PWD>X</GENERATE_PWD>` +
      `<RETURN></RETURN>`
  );
  if (res.status !== 200) {
    console.log(`${u}: HTTP ${res.status} ${plain(res.body).slice(0, 300)}`);
    continue;
  }
  for (const m of messages(res.body)) console.log(`${u}: [${m.type}] ${m.message}`);
}

console.log("--- read back");
for (const u of users) {
  const res = await callRfc("BAPI_USER_GET_DETAIL", `<USERNAME>${u}</USERNAME><RETURN></RETURN>`);
  const exists = tag(res.body, "USTYP").length > 0;
  console.log(
    `${u}: ${exists ? "exists" : "NOT FOUND"}; type ${tag(res.body, "USTYP")[0] ?? "-"}; ` +
      `name ${tag(res.body, "FULLNAME")[0] ?? "-"}; locked(wrong logons/local/global) ` +
      `${tag(res.body, "WRNG_LOGON")[0] ?? "-"}/${tag(res.body, "LOCAL_LOCK")[0] ?? "-"}/${tag(res.body, "GLOB_LOCK")[0] ?? "-"}`
  );
}
