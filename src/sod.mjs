// SoD (segregation of duties) check against the sample matrix in data/sod/sod-matrix.json
// (built by scripts/build_sod_matrix.py). Combines the roles of the given users with the requested
// roles and reports every risk pair one person would hold. Read-only; demo rule set, not SAP GRC.
import { readFileSync } from "node:fs";
import { getUser } from "./users.mjs";

let matrix;
const loadMatrix = () =>
  (matrix ??= JSON.parse(readFileSync(new URL("../data/sod/sod-matrix.json", import.meta.url), "utf8")));

export async function checkSod({ usernames = [], roles = [] }) {
  if (!usernames.length && !roles.length) throw new Error("Give at least one user name or role");
  const m = loadMatrix();

  // role -> where it comes from (a user's current roles, or the request)
  const sources = new Map();
  const add = (role, from) => sources.set(role, [...(sources.get(role) || []), from]);
  for (const u of usernames) for (const r of (await getUser({ username: u.toUpperCase() })).roles) add(r.role, u.toUpperCase());
  for (const r of roles) add(r.toUpperCase(), "requested");

  const checked = [], notChecked = [];
  const holders = {}; // function -> [{ role, apps }]
  for (const [role, from] of sources) {
    const entry = m.roles[role];
    if (!entry || !entry.hasContent) {
      notChecked.push({ role, from, why: entry ? "role has no authorization content in this client" : "role not in the SoD matrix" });
      continue;
    }
    checked.push({ role, text: entry.text, from, functions: Object.keys(entry.functions) });
    for (const [f, apps] of Object.entries(entry.functions)) (holders[f] ||= []).push({ role, apps });
  }

  const conflicts = m.risks
    .filter((r) => r.functions.every((f) => holders[f]))
    .map((r) => ({
      id: r.id,
      level: r.level,
      risk: r.risk,
      because: r.functions.map((f) => ({
        function: m.functions[f].description,
        roles: holders[f].map((h) => `${h.role} (${h.apps.map((a) => m.appTitles[a] || a).join(", ")})`),
      })),
    }));

  return {
    verdict: conflicts.length
      ? `${conflicts.length} SoD conflict(s) found: needs an explicit, justified approval or a different role set`
      : notChecked.length
        ? "No SoD conflict found among the roles that could be checked"
        : "No SoD conflict found",
    conflicts,
    checkedRoles: checked,
    notChecked,
    note: "Sample rule set based on app titles of SAP_BR business roles, not SAP GRC. In production this would call GRC Access Control or IAG.",
  };
}
