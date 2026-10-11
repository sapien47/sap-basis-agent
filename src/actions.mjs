// Write actions as the agent sees them. Every action follows the same steps:
//   1. check   - read the current state in SAP, skip what makes no sense (already locked, protected user...)
//   2. approve - show the plan to the human through the MCP client; no approval, no change
//   3. execute - call the BAPI
//   4. verify  - read the user again and report the real state after the change
//   5. audit   - append who asked, what was approved, what ran and the outcome to the audit log
import { getUser, lockUser, unlockUser, createUser, changeUser, setRoles, localDate, systemInfo, loggedOnUsers } from "./users.mjs";
import { showOnce } from "./approval-window.mjs";
import * as reply from "./replies.mjs";
import { askHuman, audit, newRequestId, openFlow, refusalStatus } from "./governance.mjs";
import { checkSod } from "./sod.mjs";

// Users the agent must never touch: SAP standard users and the agent's own technical user.
const PROTECTED = ["SAP*", "DDIC", "SAPSYS", "TMSADM", "EARLYWATCH", "SAPCPIC"];
const isProtected = (u) => PROTECTED.includes(u) || u === String(process.env.SAP_USER || "").toUpperCase();

let systemLabel;
async function system() {
  if (!systemLabel) {
    const s = await systemInfo();
    systemLabel = `${s.systemId}/${s.client}`;
  }
  return systemLabel;
}

async function tryGetUser(name) {
  try {
    return await getUser({ username: name });
  } catch {
    return null;
  }
}

// Lock or unlock several users with a single approval.
async function changeLock(mcpServer, { usernames, reason }, lock) {
  const action = lock ? "lock" : "unlock";
  const requestId = newRequestId();
  const names = [...new Set(usernames.map((u) => u.trim().toUpperCase()))];

  // 1. check
  const todo = [];
  const skipped = [];
  for (const name of names) {
    if (isProtected(name)) { skipped.push({ username: name, why: "protected user, the agent may not change it" }); continue; }
    const u = await tryGetUser(name);
    if (!u) { skipped.push({ username: name, why: "user does not exist" }); continue; }
    if (lock && u.lockReasons.includes("locked by administrator")) { skipped.push({ username: name, why: "already locked" }); continue; }
    if (!lock && !u.locked) { skipped.push({ username: name, why: "not locked" }); continue; }
    todo.push({ username: name, fullName: u.fullName, before: u.locked ? u.lockReasons.join(", ") : "unlocked" });
  }
  if (!todo.length) {
    const result = { requestId, action, status: "nothing to do", skipped };
    await audit({ requestId, action, reason, status: result.status, skipped });
    return result;
  }

  // 2. approve
  const sys = await system();
  const message =
    `The AI agent asks to ${action.toUpperCase()} ${todo.length} SAP user(s) in ${sys}:\n` +
    todo.map((t) => `  - ${t.username} (${t.fullName || "no name"}), now: ${t.before}`).join("\n") +
    `\nReason given: ${reason}` +
    (skipped.length ? `\nSkipped: ${skipped.map((s) => `${s.username} (${s.why})`).join(", ")}` : "") +
    `\nRequest ${requestId}`;
  const approval = await askHuman(mcpServer, message);
  if (!approval.approved) {
    const status = refusalStatus(approval);
    await audit({ requestId, action, reason, users: todo.map((t) => t.username), status, approval, skipped });
    return { requestId, action, status, comment: approval.comment, users: todo.map((t) => t.username), skipped };
  }

  // 3. execute + 4. verify
  const results = [];
  for (const t of todo) {
    const bapi = lock ? await lockUser(t.username) : await unlockUser(t.username);
    const after = await tryGetUser(t.username);
    const nowLocked = after?.lockReasons.includes("locked by administrator") || false;
    results.push({
      username: t.username,
      bapi,
      verified: lock ? nowLocked : after ? !after.locked : false,
      stateAfter: after ? (after.locked ? after.lockReasons.join(", ") : "unlocked") : "unknown",
    });
  }

  // 5. audit
  const status = results.every((r) => r.verified) ? "done" : "done with problems";
  await audit({ requestId, action, reason, status, approval, results, skipped });
  return {
    requestId, action, status, approvedBy: approval.answeredBy, approvalComment: approval.comment,
    results: results.map((r) => ({ username: r.username, verified: r.verified, stateAfter: r.stateAfter, sapMessages: r.bapi.messages.map((m) => m.message) })),
    skipped,
  };
}

export const lockUsers = (mcpServer, args) => changeLock(mcpServer, args, true);
export const unlockUsers = (mcpServer, args) => changeLock(mcpServer, args, false);

// Hand a generated initial password to the human on a one-time page. Returns what the AI may know.
function handOverPassword(username, password, sys) {
  if (!password) return "no password returned by SAP";
  showOnce({
    title: `Initial password for ${username}`,
    intro: `SAP generated this initial password for ${username} in ${sys}. Give it to the user through a secure channel; they must change it at first logon.`,
    secret: password,
  });
  return "shown once to the human in the browser, not to the AI";
}

// SoD check of a role list (plus the current roles of the given users), never throws:
// a failed check is reported, not skipped silently.
async function sodFor(roles, usernames = []) {
  if (!roles.length && !usernames.length) return { verdict: "No roles, nothing to check", conflicts: [], notChecked: [] };
  try {
    return await checkSod({ roles, usernames });
  } catch (err) {
    return { verdict: `SoD check could not run: ${err.message}`, conflicts: [], notChecked: [] };
  }
}

// The SoD part of an approval message, with the human's override if there was one.
export function sodLines(sod, decision = null) {
  const lines = [`SoD check: ${sod.verdict}`];
  for (const c of sod.conflicts) {
    lines.push(`  !! ${c.id} ${c.level}: ${c.risk}`);
    for (const b of c.because) lines.push(`     - ${b.function}: ${b.roles.join("; ")}`);
  }
  if (sod.notChecked.length) lines.push(`  not checked: ${sod.notChecked.map((n) => n.role).join(", ")}`);
  if (decision?.override) lines.push(`SoD conflict overridden by ${decision.by}: ${decision.justification}`);
  return lines.join("\n");
}

// Workflow step "sod": check `roles` plus the current roles of `usernames`. On a conflict the human
// stops the request or overrides it with a justification (client channel: decided at approval).
// Returns { sod, sodSummary, sodDecision, exit }; `exit` = [status, details] when the request must end.
async function sodStep(flow, roles, usernames = []) {
  flow.step("sod", "running");
  const sod = await sodFor(roles, usernames);
  const sodSummary = { verdict: sod.verdict, conflicts: sod.conflicts.map((c) => `${c.id} ${c.level}: ${c.risk}`), notChecked: sod.notChecked.map((n) => n.role) };
  if (!sod.conflicts.length) {
    flow.step("sod", "done", sodLines(sod));
    return { sod, sodSummary, sodDecision: null };
  }
  flow.step("sod", "warning", sodLines(sod));
  flow.note(`SoD check found ${sod.conflicts.length} conflict(s): ${sodSummary.conflicts.join("; ")}`);
  const d = await flow.sodDecision(sodLines(sod) + "\n\nOne person should not hold these together. Stop the request, or override it with a justification (written to the audit log).");
  if (d.noAnswer) {
    flow.step("sod", "failed", sodLines(sod) + "\n\nNo decision in time.");
    return { sod, sodSummary, sodDecision: null, exit: ["not approved: no human answer", { comment: d.comment, sod: sodSummary }] };
  }
  if (d.decidedAtApproval) return { sod, sodSummary, sodDecision: d };
  if (!d.override) {
    flow.step("sod", "failed", sodLines(sod) + `\n\nStopped by ${d.by}.`);
    return { sod, sodSummary, sodDecision: d, exit: ["stopped: SoD conflict", { comment: d.justification, sod: sodSummary, sodDecision: d }] };
  }
  flow.step("sod", "overridden", sodLines(sod, d));
  return { sod, sodSummary, sodDecision: d };
}

// Workflow step "approve". Client channel: approving a request that shows an SoD conflict accepts
// the conflict, and the approval comment is the justification. Returns { approval, sodDecision }.
async function approveStep(flow, message, sodDecision) {
  flow.step("approve", "running", "Waiting for your approval.");
  const approval = await flow.approve(message);
  if (!approval.approved) {
    flow.step("approve", "failed", approval.comment || "Not approved.");
    return { approval, sodDecision: sodDecision?.decidedAtApproval ? null : sodDecision };
  }
  if (sodDecision?.decidedAtApproval) sodDecision = { override: true, justification: approval.comment, by: approval.answeredBy, via: "approval dialog" };
  flow.step("approve", "done", `Approved by ${approval.answeredBy}${approval.comment ? `: ${approval.comment}` : ""}`);
  return { approval, sodDecision };
}

const CREATE_STEPS = [
  { id: "parse", label: "Parse request" },
  { id: "check", label: "Check user names" },
  { id: "template", label: "Read template roles" },
  { id: "sod", label: "SoD conflict check" },
  { id: "approve", label: "Human approval" },
  { id: "create", label: "Create SAP user" },
  { id: "roles", label: "Copy template roles" },
  { id: "verify", label: "Verify in SAP" },
  { id: "handover", label: "Hand over password" },
  { id: "close", label: "Audit log & ticket reply" },
];

// Shown as a live workflow (see openFlow): each step reports to the page, and the human starts it,
// decides on an SoD conflict (stop, or override with a justification) and approves.
export async function createUserLike(mcpServer, { newUsername, templateUsername, firstName, lastName, reason, replyLanguage = "en" }) {
  const action = "create user";
  const requestId = newRequestId();
  const name = newUsername.trim().toUpperCase();
  const templateName = templateUsername.trim().toUpperCase();
  const sys = await system();
  const flow = await openFlow(mcpServer, {
    title: `Create SAP user ${name} like ${templateName}`,
    requestId,
    facts: [["New user", `${name} (${firstName} ${lastName})`], ["Copied from", templateName], ["System", sys], ["Reason", reason]],
    steps: CREATE_STEPS,
  });
  const base = { requestId, action, reason, newUser: name, template: templateName };
  // Every early exit: audit, show the end on the page, answer the agent.
  const stop = async (status, extra) => {
    await audit({ ...base, status, ...extra });
    flow.end(status, extra.problem || extra.comment || "");
    return { requestId, action, status, ...extra };
  };

  const started = await flow.begin();
  if (!started.started) return stop(started.status, { comment: started.comment });
  flow.step("parse", "done", `New user ${name} (${firstName} ${lastName}), copied from ${templateName}.\nReason: ${reason}`);

  // 1. check
  flow.step("check", "running");
  let problem = null;
  if (isProtected(name)) problem = `${name} is a protected user name`;
  else if (await tryGetUser(name)) problem = `user ${name} already exists`;
  const template = problem ? null : await tryGetUser(templateName);
  if (!problem && !template) problem = `template user ${templateName} does not exist`;
  if (problem) {
    flow.step("check", "failed", problem);
    return stop("not possible", { problem });
  }
  flow.step("check", "done", `${name} is free. Template ${templateName} exists: ${template.userType} user, valid to ${template.validTo || "unlimited"}.`);
  flow.note(`Read ${templateName} with BAPI_USER_GET_DETAIL`);
  flow.step("template", "done", `${template.roles.length} role(s):\n` + (template.roles.map((r) => `  - ${r.role} (${r.text || "no text"})`).join("\n") || "  none"));

  const { sod, sodSummary, sodDecision: decided, exit } = await sodStep(flow, template.roles.map((r) => r.role));
  if (exit) return stop(...exit);

  // 2. approve
  const message =
    `The AI agent asks to CREATE SAP user ${name} (${firstName} ${lastName}) in ${sys}, copied from ${templateName}:\n` +
    `  - user type: ${template.userType}, user group: ${template.userGroup || "none"}, valid to: ${template.validTo || "unlimited"}\n` +
    `  - roles (${template.roles.length}): ${template.roles.map((r) => r.role).join(", ") || "none"}\n` +
    `  - initial password generated by SAP, shown only to you in the browser after creation\n` +
    `${sodLines(sod, decided)}\n` +
    `Reason given: ${reason}\nRequest ${requestId}`;
  const { approval, sodDecision } = await approveStep(flow, message, decided);
  if (!approval.approved) return stop(refusalStatus(approval), { comment: approval.comment, approval, sod: sodSummary, sodDecision });

  // 3. execute
  flow.step("create", "running");
  const run = await createUser({ newUsername: name, template: { ...template, roles: [] }, firstName, lastName });
  const sapText = (s) => s.messages.map((m) => m.message).join("\n") || "no message";
  flow.step("create", run.ok ? "done" : "failed", `BAPI_USER_CREATE1: ${sapText(run.steps[0])}`);
  flow.note(`Called BAPI_USER_CREATE1 for ${name}: ${run.ok ? "OK" : "error"}`);
  const steps = [...run.steps];
  if (run.ok && template.roles.length) {
    flow.step("roles", "running");
    const today = localDate();
    const r = await setRoles(name, template.roles.map((t) => ({ role: t.role, validFrom: today, validTo: t.validTo || "9999-12-31" })));
    steps.push(r);
    flow.step("roles", r.ok ? "done" : "failed", `BAPI_USER_ACTGROUPS_ASSIGN, ${template.roles.length} role(s): ${sapText(r)}`);
    flow.note(`Called BAPI_USER_ACTGROUPS_ASSIGN for ${name}: ${r.ok ? "OK" : "error"}`);
  } else {
    flow.step("roles", "skipped", run.ok ? "The template has no roles." : "Not run: the user was not created.");
  }

  // 4. verify
  flow.step("verify", "running");
  const after = await tryGetUser(name);
  const verified = Boolean(after) && after.roles.length === template.roles.length;
  const status = steps.every((s) => s.ok) && verified ? "done" : "done with problems";
  flow.step("verify", verified ? "done" : "failed",
    after ? `Read back from SAP: ${after.userType} user, ${after.roles.length} role(s): ${after.roles.map((r) => r.role).join(", ") || "none"}` : `${name} could not be read back.`);

  let initialPassword = "no password returned by SAP";
  if (run.password) initialPassword = flow.handOver("initial password", run.password) || handOverPassword(name, run.password, sys);
  flow.step("handover", run.password ? "done" : "skipped", initialPassword);

  // 5. audit (never the password itself)
  await audit({ ...base, status, approval, sod: sodSummary, sodDecision, steps, verified, initialPassword });
  const user = after && { username: after.username, fullName: after.fullName, userType: after.userType, validTo: after.validTo, roles: after.roles.map((r) => r.role) };
  const ticketReply = user && status === "done" ? reply.created(user, templateName, sys, replyLanguage) : null;
  flow.step("close", "done", `Audit log entry ${requestId} written.` + (ticketReply ? "\nTicket reply ready (see Result)." : ""));
  flow.end(status, ticketReply || "");
  return {
    requestId, action, status, approvedBy: approval.answeredBy, approvalComment: approval.comment,
    user, initialPassword, sod: sodSummary, sodDecision,
    sapMessages: steps.flatMap((s) => s.messages.map((m) => m.message)),
    ticketReply,
  };
}

const ASSIGN_STEPS = [
  { id: "parse", label: "Parse request" },
  { id: "check", label: "Check user" },
  { id: "current", label: "Read current roles" },
  { id: "sod", label: "SoD conflict check" },
  { id: "approve", label: "Human approval" },
  { id: "assign", label: "Assign roles" },
  { id: "verify", label: "Verify in SAP" },
  { id: "close", label: "Audit log & ticket reply" },
];

// Access request: add roles to an existing user, as a live workflow (see openFlow). The SoD check
// covers the user's current roles plus the requested ones. Current roles are kept: the BAPI
// replaces the whole list, so they are sent again.
export async function assignRoles(mcpServer, { username: rawName, roles, validTo, reason, replyLanguage = "en" }) {
  const action = "assign roles";
  const requestId = newRequestId();
  const name = rawName.trim().toUpperCase();
  const today = localDate();
  const roleEnd = validTo || "9999-12-31";
  const requested = [...new Set(roles.map((r) => r.trim().toUpperCase()))];
  const active = (r) => (!r.validFrom || r.validFrom <= today) && (!r.validTo || r.validTo >= today);
  const sys = await system();
  const flow = await openFlow(mcpServer, {
    title: `Add ${requested.length} role(s) to SAP user ${name}`,
    requestId,
    facts: [["User", name], ["Roles to add", requested.join(", ")], ["Role valid to", validTo || "unlimited"], ["System", sys], ["Reason", reason]],
    steps: ASSIGN_STEPS,
  });
  const base = { requestId, action, reason, users: [name] };
  const stop = async (status, extra) => {
    await audit({ ...base, status, ...extra });
    flow.end(status, extra.problem || extra.comment || "");
    return { requestId, action, status, ...extra };
  };

  const started = await flow.begin();
  if (!started.started) return stop(started.status, { comment: started.comment, roles: requested });
  flow.step("parse", "done", `Add to ${name}: ${requested.join(", ")}, valid ${today} to ${roleEnd}.\nReason: ${reason}`);

  // 1. check
  flow.step("check", "running");
  let problem = null;
  const u = isProtected(name) ? null : await tryGetUser(name);
  if (isProtected(name)) problem = `${name} is a protected user, the agent may not change it`;
  else if (!u) problem = `user ${name} does not exist`;
  else if (validTo && validTo < today) problem = `the requested role validity end ${validTo} is in the past`;
  if (problem) {
    flow.step("check", "failed", problem);
    return stop("not possible", { problem, roles: requested });
  }
  flow.step("check", "done", `${name} (${u.fullName || "no name"}) exists: ${u.userType} user, ${u.locked ? `locked (${u.lockReasons.join(", ")})` : "not locked"}, valid to ${u.validTo || "unlimited"}.`);
  flow.note(`Read ${name} with BAPI_USER_GET_DETAIL`);

  const current = new Map(u.roles.map((r) => [r.role, r]));
  const skipped = requested.filter((r) => current.has(r) && active(current.get(r))).map((role) => ({ role, why: "already assigned and active" }));
  const todo = requested.filter((r) => !skipped.some((s) => s.role === r));
  const kept = u.roles.filter((r) => !todo.includes(r.role));
  flow.step("current", "done",
    `${u.roles.length} current role(s), all kept:\n` + (u.roles.map((r) => `  - ${r.role} (${r.validFrom} to ${r.validTo})`).join("\n") || "  none") +
    (skipped.length ? `\nAlready assigned, skipped: ${skipped.map((s) => s.role).join(", ")}` : "") +
    (todo.length ? `\nTo add: ${todo.join(", ")}` : "\nNothing to add."));
  if (!todo.length) return stop("nothing to do", { roles: requested, skipped, comment: "Every requested role is already assigned and active." });

  const { sod, sodSummary, sodDecision: decided, exit } = await sodStep(flow, todo, [name]);
  if (exit) return stop(exit[0], { ...exit[1], roles: todo, skipped });

  // 2. approve
  const message =
    `The AI agent asks to ASSIGN ${todo.length} role(s) to SAP user ${name} (${u.fullName || "no name"}) in ${sys}:\n` +
    todo.map((r) => `  - add ${r}${current.has(r) ? " (assigned but expired: renew)" : ""}, valid ${today} to ${roleEnd}`).join("\n") +
    `\n  - keeps its current roles (${kept.length}): ${kept.map((r) => r.role).join(", ") || "none"}\n` +
    `${sodLines(sod, decided)}\n` +
    `Reason given: ${reason}` +
    (skipped.length ? `\nSkipped: ${skipped.map((s) => `${s.role} (${s.why})`).join(", ")}` : "") +
    `\nRequest ${requestId}`;
  const { approval, sodDecision } = await approveStep(flow, message, decided);
  if (!approval.approved) return stop(refusalStatus(approval), { comment: approval.comment, approval, roles: todo, sod: sodSummary, sodDecision, skipped });

  // 3. execute: the full list, current roles with their own dates plus the new ones
  flow.step("assign", "running");
  const step = await setRoles(name, [
    ...kept.map((r) => ({ role: r.role, validFrom: r.validFrom || today, validTo: r.validTo || "9999-12-31" })),
    ...todo.map((role) => ({ role, validFrom: today, validTo: roleEnd })),
  ]);
  flow.step("assign", step.ok ? "done" : "failed",
    `BAPI_USER_ACTGROUPS_ASSIGN with ${kept.length + todo.length} role(s): ${kept.length} kept + ${todo.length} new.\nSAP: ${step.messages.map((m) => m.message).join("\n") || "no message"}`);
  flow.note(`Called BAPI_USER_ACTGROUPS_ASSIGN for ${name}: ${step.ok ? "OK" : "error"}`);

  // 4. verify: new roles active, no current role lost
  flow.step("verify", "running");
  const after = await tryGetUser(name);
  const lost = after ? kept.filter((k) => !after.roles.some((r) => r.role === k.role)).map((k) => k.role) : kept.map((k) => k.role);
  const missing = after ? todo.filter((role) => !after.roles.some((r) => r.role === role && active(r))) : todo;
  const verified = Boolean(after) && !lost.length && !missing.length;
  const status = step.ok && verified ? "done" : "done with problems";
  flow.step("verify", verified ? "done" : "failed",
    after ? `Read back from SAP: ${after.roles.length} role(s): ${after.roles.map((r) => r.role).join(", ") || "none"}\n` +
      (verified ? `All ${kept.length} previous role(s) still there, ${todo.length} new role(s) active.` : `Lost: ${lost.join(", ") || "none"}. Not active: ${missing.join(", ") || "none"}.`)
      : `${name} could not be read back.`);

  // 5. audit
  await audit({ ...base, roles: todo, status, approval, sod: sodSummary, sodDecision, skipped, steps: [step], verified, rolesAfter: after?.roles.map((r) => r.role) });
  const ticketReply = status === "done" ? reply.rolesAssigned(after, todo, roleEnd, sys, replyLanguage) : null;
  flow.step("close", "done", `Audit log entry ${requestId} written.` + (ticketReply ? "\nTicket reply ready (see Result)." : ""));
  flow.end(status, ticketReply || "");
  return {
    requestId, action, status, approvedBy: approval.answeredBy, approvalComment: approval.comment,
    rolesAdded: todo, rolesAfter: after?.roles.map((r) => ({ role: r.role, validTo: r.validTo })), sod: sodSummary, sodDecision, skipped,
    sapMessages: step.messages.map((m) => m.message),
    ticketReply,
  };
}

const DEACTIVATE_STEPS = [
  { id: "parse", label: "Parse request" },
  { id: "check", label: "Check users" },
  { id: "sessions", label: "Check open sessions" },
  { id: "approve", label: "Human approval" },
  { id: "lock", label: "Lock users" },
  { id: "validity", label: "End validity today" },
  { id: "verify", label: "Verify in SAP" },
  { id: "close", label: "Audit log & ticket reply" },
];

// Leaver: lock the users and end their validity today, with one approval for the whole list, as a
// live workflow (see openFlow). Roles are kept, so the audit trail still shows what the user could do.
export async function deactivateUsers(mcpServer, { usernames, reason, replyLanguage = "en" }) {
  const action = "deactivate";
  const requestId = newRequestId();
  const today = localDate();
  const names = [...new Set(usernames.map((u) => u.trim().toUpperCase()))];
  const sys = await system();
  const flow = await openFlow(mcpServer, {
    title: `Deactivate ${names.length} leaver(s): ${names.join(", ")}`,
    requestId,
    facts: [["Users", names.join(", ")], ["Action", "lock + end validity today, roles kept"], ["System", sys], ["Reason", reason]],
    steps: DEACTIVATE_STEPS,
  });
  const stop = async (status, extra) => {
    await audit({ requestId, action, reason, status, ...extra });
    flow.end(status, extra.comment || "");
    return { requestId, action, status, ...extra };
  };

  const started = await flow.begin();
  if (!started.started) return stop(started.status, { comment: started.comment, users: names });
  flow.step("parse", "done", `Leaver(s): ${names.join(", ")}.\nReason: ${reason}`);

  // 1. check
  flow.step("check", "running");
  const todo = [];
  const skipped = [];
  for (const name of names) {
    if (isProtected(name)) { skipped.push({ username: name, why: "protected user, the agent may not change it" }); continue; }
    const u = await tryGetUser(name);
    if (!u) { skipped.push({ username: name, why: "user does not exist" }); continue; }
    const lockedNow = u.lockReasons.includes("locked by administrator");
    const endedNow = u.validTo !== null && u.validTo <= today;
    if (lockedNow && endedNow) { skipped.push({ username: name, why: "already deactivated" }); continue; }
    todo.push({ username: name, fullName: u.fullName, lockedNow, endedNow, validTo: u.validTo, roles: u.roles.length });
  }
  flow.note(`Read ${names.length} user(s) with BAPI_USER_GET_DETAIL`);
  const checkText =
    todo.map((t) => `${t.username} (${t.fullName || "no name"}): ${t.lockedNow ? "already locked" : "not locked"}, valid to ${t.validTo || "no end date"}, ${t.roles} role(s)`).join("\n") +
    (skipped.length ? `\nSkipped: ${skipped.map((s) => `${s.username} (${s.why})`).join(", ")}` : "");
  if (!todo.length) {
    flow.step("check", "done", checkText);
    return stop("nothing to do", { skipped, comment: "No user left to deactivate." });
  }
  flow.step("check", "done", checkText);

  // Read-only: a lock blocks new logons but does not end open sessions.
  flow.step("sessions", "running");
  let open = [];
  try {
    const s = await loggedOnUsers();
    open = s.sessions.filter((x) => todo.some((t) => t.username === x.username));
    flow.step("sessions", "done", open.length
      ? `Still logged on: ${[...new Set(open.map((x) => x.username))].join(", ")}. The lock blocks new logons only; end open sessions in SM04 if needed.\n(${s.note})`
      : `None of the users is logged on. (${s.note})`);
  } catch (err) {
    flow.step("sessions", "done", `Could not read the sessions: ${err.message.slice(0, 200)}`);
  }

  // 2. approve
  const message =
    `The AI agent asks to DEACTIVATE ${todo.length} SAP user(s) in ${sys} (leaver):\n` +
    todo.map((t) => `  - ${t.username} (${t.fullName || "no name"}): ` +
      [!t.lockedNow && "lock", !t.endedNow && `end validity today (now: ${t.validTo || "no end date"})`].filter(Boolean).join(" + ") +
      `; keeps ${t.roles} role(s) for the audit trail`).join("\n") +
    (open.length ? `\nStill logged on: ${[...new Set(open.map((x) => x.username))].join(", ")}` : "") +
    `\nReason given: ${reason}` +
    (skipped.length ? `\nSkipped: ${skipped.map((s) => `${s.username} (${s.why})`).join(", ")}` : "") +
    `\nRequest ${requestId}`;
  const { approval } = await approveStep(flow, message, null);
  if (!approval.approved) return stop(refusalStatus(approval), { comment: approval.comment, approval, users: todo.map((t) => t.username), skipped });

  // 3. execute
  const steps = new Map(todo.map((t) => [t.username, []]));
  const sapText = (r) => r.messages.map((m) => m.message).join("; ") || "no message";
  const toLock = todo.filter((t) => !t.lockedNow);
  flow.step("lock", "running");
  const lockLines = todo.filter((t) => t.lockedNow).map((t) => `${t.username}: already locked`);
  for (const t of toLock) {
    const r = await lockUser(t.username);
    steps.get(t.username).push(r);
    lockLines.push(`${t.username}: BAPI_USER_LOCK ${r.ok ? "OK" : "error"} (${sapText(r)})`);
  }
  flow.step("lock", toLock.every((t) => steps.get(t.username).every((r) => r.ok)) ? "done" : "failed", lockLines.join("\n"));
  if (toLock.length) flow.note(`Called BAPI_USER_LOCK for ${toLock.map((t) => t.username).join(", ")}`);

  const toEnd = todo.filter((t) => !t.endedNow);
  flow.step("validity", "running");
  const endLines = todo.filter((t) => t.endedNow).map((t) => `${t.username}: validity already ended (${t.validTo})`);
  const endResults = [];
  for (const t of toEnd) {
    const r = (await changeUser(t.username, { validTo: today })).result;
    steps.get(t.username).push(r);
    endResults.push(r);
    endLines.push(`${t.username}: BAPI_USER_CHANGE valid to ${today} ${r.ok ? "OK" : "error"} (${sapText(r)})`);
  }
  flow.step("validity", endResults.every((r) => r.ok) ? "done" : "failed", endLines.join("\n"));
  if (toEnd.length) flow.note(`Called BAPI_USER_CHANGE (validity end ${today}) for ${toEnd.map((t) => t.username).join(", ")}`);

  // 4. verify
  flow.step("verify", "running");
  const results = [];
  for (const t of todo) {
    const after = await tryGetUser(t.username);
    const verified = Boolean(after) && after.lockReasons.includes("locked by administrator") && after.validTo !== null && after.validTo <= today;
    results.push({ username: t.username, steps: steps.get(t.username), verified, stateAfter: after ? { locked: after.locked, validTo: after.validTo, roles: after.roles.length } : "unknown" });
  }
  const status = results.every((r) => r.verified) ? "done" : "done with problems";
  flow.step("verify", status === "done" ? "done" : "failed", results.map((r) =>
    `${r.username}: ${r.stateAfter === "unknown" ? "could not be read back" : `${r.stateAfter.locked ? "locked" : "NOT locked"}, valid to ${r.stateAfter.validTo || "no end date"}, ${r.stateAfter.roles} role(s) kept`}${r.verified ? "" : "  <- not as expected"}`).join("\n"));

  // 5. audit
  await audit({ requestId, action, reason, status, approval, results, skipped });
  const done = results.filter((r) => r.verified).map((r) => r.username);
  const ticketReply = done.length ? reply.deactivated(done, sys, replyLanguage) : null;
  flow.step("close", "done", `Audit log entry ${requestId} written.` + (ticketReply ? "\nTicket reply ready (see Result)." : ""));
  flow.end(status, ticketReply || "");
  return {
    requestId, action, status, approvedBy: approval.answeredBy, approvalComment: approval.comment,
    results: results.map((r) => ({ username: r.username, verified: r.verified, stateAfter: r.stateAfter, sapMessages: r.steps.flatMap((s) => s.messages.map((m) => m.message)) })),
    skipped, stillLoggedOn: [...new Set(open.map((x) => x.username))],
    ticketReply,
  };
}

// Returning user or access extension: unlock if locked, extend the validity, optionally a new initial password.
export async function reactivateUser(mcpServer, { username: rawName, validTo, newPassword = true, reason, replyLanguage = "en" }) {
  const action = "reactivate";
  const requestId = newRequestId();
  const name = rawName.trim().toUpperCase();
  const today = localDate();

  // 1. check
  let problem = null;
  const u = isProtected(name) ? null : await tryGetUser(name);
  if (isProtected(name)) problem = `${name} is a protected user, the agent may not change it`;
  else if (!u) problem = `user ${name} does not exist`;
  else if (validTo && validTo < today) problem = `the requested validity end ${validTo} is in the past`;
  if (problem) {
    await audit({ requestId, action, reason, users: [name], status: "not possible", problem });
    return { requestId, action, status: "not possible", problem };
  }
  // Extend only when asked, or when the current end date is today or earlier (default: 90 days from today).
  const newValidTo = validTo || (u.validTo && u.validTo <= today ? localDate(90) : null);
  const plan = { unlock: u.locked, validTo: newValidTo && newValidTo !== u.validTo ? newValidTo : null, newPassword };
  if (!plan.unlock && !plan.validTo && !plan.newPassword) {
    await audit({ requestId, action, reason, users: [name], status: "nothing to do" });
    return { requestId, action, status: "nothing to do", why: `${name} is not locked and its validity (${u.validTo || "no end date"}) is fine` };
  }

  // 2. approve
  const sys = await system();
  const message =
    `The AI agent asks to REACTIVATE SAP user ${name} (${u.fullName || "no name"}) in ${sys}:\n` +
    [
      plan.unlock && `  - unlock (now: ${u.lockReasons.join(", ")})`,
      plan.validTo && `  - set validity end to ${plan.validTo} (now: ${u.validTo || "no end date"})`,
      plan.newPassword && `  - new initial password generated by SAP, shown only to you in the browser; the user must change it at first logon`,
    ].filter(Boolean).join("\n") +
    `\nReason given: ${reason}\nRequest ${requestId}`;
  const approval = await askHuman(mcpServer, message);
  if (!approval.approved) {
    const status = refusalStatus(approval);
    await audit({ requestId, action, reason, users: [name], status, approval });
    return { requestId, action, status, comment: approval.comment };
  }

  // 3. execute + 4. verify
  const steps = [];
  if (plan.unlock) steps.push(await unlockUser(name));
  let password = null;
  if (plan.validTo || plan.newPassword) {
    const change = await changeUser(name, { validTo: plan.validTo, newPassword: plan.newPassword });
    steps.push(change.result);
    password = change.password;
  }
  const after = await tryGetUser(name);
  const verified = Boolean(after) && !after.locked && (!plan.validTo || after.validTo === plan.validTo) && (!plan.newPassword || Boolean(password));
  const status = verified ? "done" : "done with problems";
  const initialPassword = plan.newPassword ? handOverPassword(name, password, sys) : "not changed";

  // 5. audit (never the password itself)
  await audit({ requestId, action, reason, users: [name], status, approval, plan, steps, verified, initialPassword });
  return {
    requestId, action, status, approvedBy: approval.answeredBy, approvalComment: approval.comment,
    stateAfter: after && { locked: after.locked, lockReasons: after.lockReasons, validTo: after.validTo },
    initialPassword,
    sapMessages: steps.flatMap((s) => s.messages.map((m) => m.message)),
    ticketReply: verified
      ? reply.reactivated(after, { unlocked: plan.unlock, validityChanged: Boolean(plan.validTo), passwordReset: plan.newPassword }, sys, replyLanguage)
      : null,
  };
}

// "I can't access SAP": read-only checks on one user, each finding with the fix the agent can propose.
export async function diagnoseAccess({ username: rawName, replyLanguage = "en" }) {
  const name = rawName.trim().toUpperCase();
  const today = localDate();
  const sys = await system();
  const u = await tryGetUser(name);
  const findings = [];
  const add = (severity, finding, fr, fix = null) => findings.push({ severity, finding, fr, fix });

  if (!u) {
    add("blocking", `User ${name} does not exist in ${sys}.`, `L'utilisateur ${name} n'existe pas dans ${sys}.`,
      "Check the user name; if it is a new joiner, create it with sap_create_user_like.");
  } else {
    if (u.lockReasons.includes("locked after too many failed logons"))
      add("blocking", "The account is locked after too many wrong passwords.", "Le compte est verrouillé après trop de mots de passe erronés.",
        "sap_reactivate_user (unlock + new initial password)");
    if (u.lockReasons.includes("locked by administrator"))
      add("blocking", "The account was locked by an administrator.", "Le compte a été verrouillé par un administrateur.",
        "Check why it was locked (leaver?) before unlocking with sap_reactivate_user.");
    if (u.lockReasons.includes("locked globally (central user administration)"))
      add("blocking", "The account is locked in central user administration.", "Le compte est verrouillé dans l'administration centrale des utilisateurs.",
        "Unlock it in the central system (CUA), not here.");
    if (u.validFrom && u.validFrom > today)
      add("blocking", `The account is only valid from ${u.validFrom}.`, `Le compte n'est valide qu'à partir du ${u.validFrom}.`, null);
    if (u.validTo && u.validTo < today)
      add("blocking", `The account expired on ${u.validTo}.`, `Le compte a expiré le ${u.validTo}.`,
        "sap_reactivate_user (extend validity)");
    else if (u.validTo && u.validTo <= localDate(14))
      add("warning", `The account expires soon, on ${u.validTo}.`, `Le compte expire bientôt, le ${u.validTo}.`,
        "sap_reactivate_user with a new validTo date");
    if (u.userTypeCode && !["A", "S"].includes(u.userTypeCode))
      add("blocking", `This is a ${u.userType} user, which cannot log on interactively.`,
        `C'est un utilisateur de type ${u.userType}, qui ne peut pas se connecter en mode dialogue.`, "Check with the requester which account they should use.");
    const activeRoles = u.roles.filter((r) => (!r.validFrom || r.validFrom <= today) && (!r.validTo || r.validTo >= today));
    if (!u.roles.length)
      add("warning", "The account has no roles: the user can log on but will not see any transaction or app.",
        "Le compte n'a aucun rôle : l'utilisateur peut se connecter mais ne verra aucune transaction ni application.",
        "Needs an access request approved by the business, then sap_assign_roles.");
    else if (!activeRoles.length)
      add("warning", "All roles of the account have expired.", "Tous les rôles du compte ont expiré.", "Role validity must be extended (access request).");
  }
  if (!findings.length)
    add("ok", "No problem found: the account exists, is not locked, is valid and has active roles.",
      "Aucun problème trouvé : le compte existe, n'est pas verrouillé, est valide et a des rôles actifs.", null);

  const blocking = findings.some((f) => f.severity === "blocking");
  return {
    username: name,
    system: sys,
    verdict: blocking ? "cannot log on" : findings.some((f) => f.severity === "warning") ? "can log on, but with a problem" : "no problem found",
    findings: findings.map(({ severity, finding, fix }) => ({ severity, finding, fix })),
    notChecked: "Password status and authorization errors inside transactions are not checked by this tool.",
    user: u && { fullName: u.fullName, userType: u.userType, locked: u.locked, validFrom: u.validFrom, validTo: u.validTo, roles: u.roles.map((r) => r.role) },
    ticketReply: reply.diagnosis(name, findings, sys, replyLanguage),
  };
}
