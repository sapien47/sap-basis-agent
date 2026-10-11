// One-off demo setup: give a demo user the roles of another user, so that "create a user like a
// colleague" copies real roles. Keeps the target's existing roles (BAPI_USER_ACTGROUPS_ASSIGN
// replaces the whole list, so the current list is merged in first). Reads the user back to confirm.
// Run: node --env-file=.env scripts/assign-demo-roles.mjs <TARGET> <SOURCE>   e.g. DEMO_01 BPINST
import { callRfc, messages, plain, esc } from "../src/sap-soap.mjs";
import { getUser, localDate } from "../src/users.mjs";

const [target, source] = process.argv.slice(2).map((u) => u?.toUpperCase());
if (!target || !source) {
  console.error("Usage: node --env-file=.env scripts/assign-demo-roles.mjs <TARGET> <SOURCE>");
  process.exit(2);
}
if (!target.startsWith("DEMO_")) {
  console.error("Only DEMO_* users can be changed by this script.");
  process.exit(2);
}

const [to, from] = [await getUser({ username: target }), await getUser({ username: source })];
const today = localDate();
const roles = new Map(to.roles.map((r) => [r.role, r]));
for (const r of from.roles) if (!roles.has(r.role)) roles.set(r.role, { role: r.role, validFrom: today, validTo: "9999-12-31" });

const items = [...roles.values()]
  .map((r) => `<item><AGR_NAME>${esc(r.role)}</AGR_NAME><FROM_DAT>${r.validFrom || today}</FROM_DAT><TO_DAT>${r.validTo || "9999-12-31"}</TO_DAT></item>`)
  .join("");
const res = await callRfc("BAPI_USER_ACTGROUPS_ASSIGN", `<USERNAME>${esc(target)}</USERNAME><ACTIVITYGROUPS>${items}</ACTIVITYGROUPS><RETURN></RETURN>`);
if (res.status !== 200) {
  console.error(`HTTP ${res.status} ${plain(res.body).slice(0, 300)}`);
  process.exit(1);
}
for (const m of messages(res.body)) console.log(`[${m.type}] ${m.message}`);

const after = await getUser({ username: target });
console.log(`--- ${target} now has ${after.roles.length} role(s):`);
for (const r of after.roles) console.log(`  ${r.role} (${r.text || "no text"}) ${r.validFrom} to ${r.validTo}`);
