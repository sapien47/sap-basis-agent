// Approval in the server's own window: a one-page local web app opened in the default browser.
// Works with any AI client. The page's secret link goes to the browser only, never to the AI,
// so the agent cannot approve its own request through the MCP connection.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function openBrowser(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

const page = (body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SAP change approval</title>
<style>
  :root { --bg:#f5f6f8; --card:#fff; --text:#1d2330; --muted:#5b6475; --line:#d9dde4; --ok:#1a7f4b; --no:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14171c; --card:#1e232b; --text:#e8ebf0; --muted:#9aa3b2; --line:#333a45; --ok:#3fb27a; --no:#f0645a; } }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, "Segoe UI", sans-serif; }
  main { max-width:640px; margin:40px auto; padding:0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 16px; font-size:14px; }
  pre { white-space:pre-wrap; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px; font:14px/1.5 ui-monospace, Consolas, monospace; }
  label { display:block; margin:16px 0 4px; font-size:14px; color:var(--muted); }
  textarea { width:100%; box-sizing:border-box; min-height:60px; padding:8px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); font:inherit; }
  .buttons { display:flex; gap:12px; margin-top:16px; }
  button { flex:1; padding:12px; border:0; border-radius:8px; color:#fff; font:600 16px system-ui, sans-serif; cursor:pointer; }
  .approve { background:var(--ok); } .reject { background:var(--no); }
</style></head><body><main><div class="card">${body}</div></main></body></html>`;

// Hand a secret (an initial password) to the human: a page that can be opened once, then is gone.
// Expires after `timeoutSeconds` if nobody opens it. Returns at once; the secret never comes back.
export function showOnce({ title, intro, secret, timeoutSeconds = 600 }) {
  const token = randomBytes(16).toString("hex");
  let shown = false;
  const server = http.createServer((req, res) => {
    if (req.url !== `/${token}` || req.method !== "GET") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page(shown ? "<h1>This page was already opened.</h1><p class=\"sub\">For safety, the password can be shown only once.</p>" : `
      <h1>${escapeHtml(title)}</h1>
      <p class="sub">${escapeHtml(intro)}</p>
      <pre style="font-size:22px;text-align:center;letter-spacing:1px">${escapeHtml(secret)}</pre>
      <p class="sub">This page can be opened only once and was not shown to the AI agent.</p>`));
    if (!shown) {
      shown = true;
      setTimeout(() => server.close(), 200);
    }
  });
  const timer = setTimeout(() => server.close(), timeoutSeconds * 1000);
  server.on("close", () => clearTimeout(timer));
  server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}/${token}`;
    if (process.env.APPROVAL_NO_BROWSER === "1") console.error(`[secret] ${url}`);
    else openBrowser(url);
  });
}

// Show `message` and wait for the human. Resolves to
//   { action: "accept", content: { approve, comment } }  when a button was clicked, or
//   { action: "timeout" }                                 when nobody answered in time.
export function askInWindow(message, { operator, timeoutSeconds = 300 } = {}) {
  const token = randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Let the "thank you" page reach the browser before closing.
      setTimeout(() => server.close(), 200);
      resolve(answer);
    };

    const server = http.createServer((req, res) => {
      if (req.url !== `/${token}`) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page(done ? "<h1>This request was already answered.</h1>" : `
          <h1>SAP change approval</h1>
          <p class="sub">The AI agent wants to change SAP. Nothing happens unless you approve.${operator ? ` Answering as <b>${escapeHtml(operator)}</b>.` : ""}</p>
          <pre>${escapeHtml(message)}</pre>
          <form method="post">
            <label for="comment">Comment (optional, goes to the audit log)</label>
            <textarea id="comment" name="comment" maxlength="500"></textarea>
            <div class="buttons">
              <button class="reject" name="decision" value="reject">Reject</button>
              <button class="approve" name="decision" value="approve">Approve</button>
            </div>
          </form>`));
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => { body = (body + chunk).slice(0, 4000); });
        req.on("end", () => {
          const form = new URLSearchParams(body);
          const decision = form.get("decision");
          if (done || (decision !== "approve" && decision !== "reject")) {
            res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("<h1>This request was already answered or the answer was not valid.</h1>"));
            return;
          }
          const approve = decision === "approve";
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(page(`<h1>${approve ? "Approved" : "Rejected"}</h1><p class="sub">Your answer was sent to the agent. You can close this tab.</p>`));
          finish({ action: "accept", content: { approve, comment: form.get("comment")?.trim() || undefined } });
        });
        return;
      }
      res.writeHead(405).end();
    });

    const timer = setTimeout(() => finish({ action: "timeout" }), timeoutSeconds * 1000);
    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // Local machine only.
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/${token}`;
      // Tests play the human themselves and read the link from stderr instead of opening a browser.
      if (process.env.APPROVAL_NO_BROWSER === "1") console.error(`[approval] ${url}`);
      else openBrowser(url);
    });
  });
}
