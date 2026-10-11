// Live workflow page: a local one-page web app, opened in the default browser, that shows a write
// request as a chain of steps updating live, and asks the human at each decision point (start,
// SoD conflict, approval). Same safety rule as the approval page: the secret link goes to the
// browser only, never to the AI, so the agent cannot click its own buttons.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { openBrowser } from "./approval-window.mjs";

// Create the workflow and its page. `steps`: [{ id, label }]. `facts`: [[label, value]].
// Returns { ask, step, note, setSecret, end, url } (see below). Throws if the page cannot start.
export async function openWorkflow({ title, requestId, operator, facts = [], steps, timeoutSeconds = 300, keepOpenSeconds = 900 }) {
  const token = randomBytes(16).toString("hex");
  const state = {
    title, requestId, operator, facts,
    steps: steps.map((s) => ({ ...s, state: "waiting", detail: "" })),
    events: [],
    prompt: null,
    result: null,
    secret: null,
  };
  let secretValue = null;
  let pending = null; // { prompt, resolve, timer }

  const time = () => new Date().toLocaleTimeString("en-GB");
  const note = (text, actor = "agent") => state.events.unshift({ time: time(), actor, text });

  // Wait for the human. `prompt`: { title, text, options: [{ value, label, style }], justification: "required" | "optional" | "none" }.
  // Resolves to { value, text } or { value: "timeout" }.
  function ask(prompt) {
    return new Promise((resolve) => {
      const id = randomBytes(6).toString("hex");
      state.prompt = { id, justification: "none", ...prompt };
      const timer = setTimeout(() => settle({ value: "timeout" }), timeoutSeconds * 1000);
      pending = { id, resolve, timer, options: prompt.options.map((o) => o.value) };
    });
  }
  function settle(answer) {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.resolve(answer);
    pending = null;
    state.prompt = null;
  }

  function step(id, s, detail) {
    const st = state.steps.find((x) => x.id === id);
    if (!st) return;
    st.state = s;
    if (detail !== undefined) st.detail = detail;
  }

  const send = (res, code, body, type = "application/json") =>
    res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" }).end(type === "application/json" ? JSON.stringify(body) : body);

  const server = http.createServer((req, res) => {
    const base = `/${token}`;
    if (req.method === "GET" && req.url === base) return send(res, 200, PAGE, "text/html");
    if (req.method === "GET" && req.url === `${base}/state`) return send(res, 200, state);
    if (req.method === "POST" && (req.url === `${base}/answer` || req.url === `${base}/secret`)) {
      let body = "";
      req.on("data", (c) => { body = (body + c).slice(0, 4000); });
      req.on("end", () => {
        if (req.url.endsWith("/secret")) {
          if (!secretValue) return send(res, 410, { error: "already shown or not available" });
          const value = secretValue;
          secretValue = null;
          state.secret.shown = true;
          note(`${state.secret.label}: shown once in this page`, operator || "human");
          return send(res, 200, { value });
        }
        let a;
        try { a = JSON.parse(body); } catch { return send(res, 400, { error: "invalid answer" }); }
        if (!pending || a.promptId !== pending.id || !pending.options.includes(a.value)) return send(res, 409, { error: "this question was already answered" });
        const text = String(a.text || "").trim().slice(0, 500);
        const opt = state.prompt.options.find((o) => o.value === a.value);
        if (opt.needsText && text.length < 10) return send(res, 400, { error: "please give a justification (at least 10 characters)" });
        send(res, 200, { ok: true });
        settle({ value: a.value, text: text || null });
      });
      return;
    }
    send(res, 404, { error: "not found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    // Local machine only.
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/${token}`;
  // Tests play the human themselves and read the link from stderr instead of opening a browser.
  if (process.env.APPROVAL_NO_BROWSER === "1") console.error(`[workflow] ${url}`);
  else openBrowser(url);

  return {
    ask, step, note,
    // Keep a secret (initial password) for the human: one click shows it once, then it is gone.
    setSecret(label, value) {
      secretValue = value;
      state.secret = { label, shown: false };
    },
    // Final status; the page stays readable for `keepOpenSeconds`, then the server stops.
    end(status, text) {
      settle({ value: "timeout" });
      for (const s of state.steps) if (s.state === "waiting") s.state = "skipped";
      state.result = { status, text: text || "" };
      setTimeout(() => server.close(), keepOpenSeconds * 1000).unref();
    },
  };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SAP Basis workflow</title>
<style>
  :root { --bg:#f4f5f8; --card:#fff; --text:#1d2330; --muted:#5b6475; --line:#dde1e8;
    --wait:#eef0f4; --run:#2f6fde; --ok:#1a8a55; --warn:#c77700; --bad:#c0362c; --ovr:#7a4cc2; }
  @media (prefers-color-scheme: dark) { :root { --bg:#13161b; --card:#1d222a; --text:#e8ebf0; --muted:#9aa3b2; --line:#323945;
    --wait:#262c36; --run:#5b8ff0; --ok:#36b27a; --warn:#e3a13a; --bad:#ef6a5e; --ovr:#a47ef0; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, "Segoe UI", sans-serif; }
  main { max-width:1200px; margin:0 auto; padding:24px 16px 48px; }
  header { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; margin-bottom:16px; }
  h1 { font-size:22px; margin:0; }
  .chip { font:600 12px system-ui; padding:3px 10px; border-radius:99px; background:var(--wait); color:var(--muted); }
  .chip.ok { background:var(--ok); color:#fff; } .chip.bad { background:var(--bad); color:#fff; } .chip.run { background:var(--run); color:#fff; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px; }
  h2 { font-size:16px; margin:0 0 12px; }
  .sub { color:var(--muted); font-size:13px; }
  .flow { display:flex; flex-wrap:wrap; gap:10px 0; align-items:stretch; }
  .node { display:flex; align-items:center; }
  .box { width:96px; min-height:62px; border-radius:10px; padding:8px 10px; background:var(--wait); border:2px solid transparent;
    font-size:12.5px; line-height:1.3; cursor:pointer; color:var(--muted); transition:background .3s, color .3s; }
  .box .n { font-size:11px; opacity:.85; display:block; margin-bottom:2px; }
  .box.done { background:var(--ok); color:#fff; } .box.running { background:var(--run); color:#fff; animation:pulse 1.2s infinite; }
  .box.warning { background:var(--warn); color:#fff; } .box.failed { background:var(--bad); color:#fff; }
  .box.overridden { background:var(--ovr); color:#fff; } .box.skipped { border:2px dashed var(--line); }
  .box.sel { outline:3px solid var(--text); outline-offset:2px; }
  .arrow { width:12px; height:2px; background:var(--line); margin:0 1px; }
  @keyframes pulse { 50% { opacity:.65; } }
  .detail { margin-top:16px; padding:12px; border-radius:8px; background:var(--bg); white-space:pre-wrap; font-size:14px; min-height:44px; }
  .prompt { border:2px solid var(--run); }
  .prompt.warn { border-color:var(--warn); }
  .prompt pre { white-space:pre-wrap; background:var(--bg); padding:12px; border-radius:8px; font:13.5px/1.5 ui-monospace, Consolas, monospace; margin:0 0 12px; }
  textarea { width:100%; min-height:60px; padding:8px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); font:inherit; }
  .buttons { display:flex; flex-wrap:wrap; gap:10px; margin-top:12px; }
  button { padding:10px 18px; border:0; border-radius:8px; color:#fff; font:600 15px system-ui, sans-serif; cursor:pointer; background:var(--run); }
  button.ok { background:var(--ok); } button.bad { background:var(--bad); } button.ovr { background:var(--ovr); } button.neutral { background:var(--muted); }
  button:disabled { opacity:.5; cursor:default; }
  .err { color:var(--bad); font-size:14px; margin-top:8px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:16px; }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 14px; margin:0; font-size:14px; }
  dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
  .ev { border-bottom:1px solid var(--line); padding:8px 0; font-size:14px; }
  .ev:last-child { border:0; }
  .ev .meta { color:var(--muted); font-size:12px; }
  .secret { font:22px ui-monospace, Consolas, monospace; letter-spacing:1px; padding:10px; text-align:center; background:var(--bg); border-radius:8px; margin-top:8px; }
  .result pre { white-space:pre-wrap; background:var(--bg); padding:12px; border-radius:8px; font:13.5px/1.5 system-ui, sans-serif; margin:8px 0 0; }
  .gone { background:var(--warn); color:#fff; padding:8px 12px; border-radius:8px; margin-bottom:12px; display:none; }
</style></head><body><main>
<div class="gone" id="gone">The workflow page has closed. What you see is the last known state.</div>
<header><h1 id="title">Loading…</h1><span class="chip" id="status"></span><span class="sub" id="req"></span></header>
<section class="card"><h2>Workflow progress</h2><div class="flow" id="flow"></div><div class="detail" id="detail"></div></section>
<section id="promptBox"></section>
<section id="resultBox"></section>
<div class="grid">
  <section class="card"><h2>Request</h2><dl id="facts"></dl></section>
  <section class="card"><h2>Activity log</h2><div class="sub" style="margin-bottom:6px">Agent actions and human decisions, newest first. Also written to the audit log.</div><div id="events"></div></section>
</div>
</main>
<script>
const base = location.pathname;
const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) if (k === "class") e.className = v; else if (k.startsWith("on")) e[k] = v; else e.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
let selected = null, shownPrompt = null, state = null, secretShown = null;
const LABEL = { waiting:"waiting", running:"running…", done:"done", warning:"needs a decision", failed:"stopped", overridden:"overridden", skipped:"skipped" };

function render() {
  const s = state;
  document.title = s.title;
  $("title").textContent = s.title;
  $("req").textContent = "Request " + s.requestId + (s.operator ? " · human: " + s.operator : "");
  const st = $("status");
  if (s.result) { st.textContent = s.result.status; st.className = "chip " + (s.result.status === "done" ? "ok" : "bad"); }
  else if (s.prompt) { st.textContent = "Waiting for you"; st.className = "chip run"; }
  else { st.textContent = "In progress"; st.className = "chip"; }

  const current = s.steps.find((x) => ["running", "warning", "failed"].includes(x.state)) || [...s.steps].reverse().find((x) => !["waiting", "skipped"].includes(x.state)) || s.steps[0];
  const sel = s.steps.find((x) => x.id === selected) || current;
  $("flow").replaceChildren(...s.steps.map((x, i) => h("div", { class: "node" },
    i ? h("div", { class: "arrow" }) : null,
    h("div", { class: "box " + x.state + (x === sel ? " sel" : ""), title: LABEL[x.state], onclick: () => { selected = x.id; render(); } },
      h("span", { class: "n" }, "Step " + (i + 1) + " · " + LABEL[x.state]), x.label))));
  $("detail").replaceChildren(h("b", null, sel.label), "\\n", sel.detail || (sel.state === "waiting" ? "Not started yet." : ""));

  $("facts").replaceChildren(...s.facts.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
  $("events").replaceChildren(...(s.events.length ? s.events.map((e) => h("div", { class: "ev" }, h("div", { class: "meta" }, e.time + " · " + e.actor), e.text)) : [h("div", { class: "sub" }, "Nothing yet.")]));

  if ((s.prompt && s.prompt.id) !== shownPrompt) renderPrompt(s.prompt);
  renderResult(s);
}

function renderPrompt(p) {
  shownPrompt = p && p.id;
  if (!p) return $("promptBox").replaceChildren();
  const ta = p.justification !== "none" ? h("textarea", { id: "just", maxlength: "500", placeholder: p.justification === "required" ? "Justification (required for the override)" : "Comment (optional)" }) : null;
  const err = h("div", { class: "err" });
  const buttons = p.options.map((o) => h("button", { class: o.style || "", onclick: async (ev) => {
    const text = ta ? ta.value.trim() : "";
    if (o.needsText && text.length < 10) { err.textContent = "Please write a justification of at least 10 characters: it goes to the audit log."; return; }
    document.querySelectorAll("#promptBox button").forEach((b) => b.disabled = true);
    const r = await fetch(base + "/answer", { method: "POST", body: JSON.stringify({ promptId: p.id, value: o.value, text }) });
    if (!r.ok) { err.textContent = (await r.json()).error; document.querySelectorAll("#promptBox button").forEach((b) => b.disabled = false); }
  } }, o.label));
  $("promptBox").replaceChildren(h("section", { class: "card prompt" + (p.tone === "warn" ? " warn" : "") },
    h("h2", null, p.title), p.text ? h("pre", null, p.text) : null, ta, h("div", { class: "buttons" }, buttons), err));
}

function renderResult(s) {
  const box = $("resultBox");
  const parts = [];
  if (s.secret) {
    const area = h("div");
    if (secretShown) area.append(h("div", { class: "secret" }, secretShown), h("div", { class: "sub" }, "Shown once. Not sent to the AI agent. Pass it to the user through a secure channel."));
    else if (s.secret.shown) area.append(h("div", { class: "sub" }, "Already shown once."));
    else area.append(h("button", { class: "neutral", onclick: async () => {
      const r = await fetch(base + "/secret", { method: "POST" });
      secretShown = r.ok ? (await r.json()).value : null; render();
    } }, "Show " + s.secret.label + " (once)"));
    parts.push(h("section", { class: "card" }, h("h2", null, s.secret.label[0].toUpperCase() + s.secret.label.slice(1)), area));
  }
  if (s.result) parts.push(h("section", { class: "card result" }, h("h2", null, "Result: " + s.result.status), s.result.text ? h("pre", null, s.result.text) : null));
  box.replaceChildren(...parts);
}

async function poll() {
  try {
    const r = await fetch(base + "/state", { cache: "no-store" });
    if (!r.ok) throw new Error();
    state = await r.json();
    render();
    setTimeout(poll, state.result ? 3000 : 600);
  } catch { $("gone").style.display = state ? "block" : "none"; if (!state) setTimeout(poll, 1000); }
}
poll();
</script></body></html>`;
