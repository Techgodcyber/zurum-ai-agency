import type { IncomingMessage, ServerResponse } from "node:http";
import { userForPanelToken, createPanelSession, destroyPanelToken } from "./tokens.js";
import { panelData, userOwnsSite, type PanelData, type PanelSite, type PanelOrder } from "./data.js";
import { readSiteFiles } from "../sites/store.js";
import { zipFiles } from "./archive.js";
import { buildSiteExport } from "./data-export.js";
import { isPublished } from "../billing/publish.js";
import { normalizePhone, createLoginOtp, verifyLoginOtp } from "./otp.js";
import { resolveUserId, setUserPhone, linkIdentity } from "../users/store.js";
import { BRAND } from "../config/brand.js";
import { env } from "../config/env.js";
import { UI_CSS, icon, logoMark, initials, THEME_INIT, themeToggle } from "../ui/theme.js";
import type { ChannelHub } from "../channels/index.js";
import { logger } from "../lib/logger.js";

/**
 * The CUSTOMER dashboard (ARCHITECTURE §9). A customer opens a magic link from
 * chat (/me/:token); that sets a long-lived, HttpOnly session cookie and drops
 * them on /dashboard, so they stay logged in and can return anytime. Every route
 * resolves the session to the customer's user_id; downloads also verify the
 * customer owns the site. Server-rendered with the shared design system.
 */

const log = logger.child({ mod: "panel" });
const COOKIE = "zpanel";

function esc(s: unknown): string {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}
function send(res: ServerResponse, code: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", ...headers });
  res.end(body);
}
function cookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie ?? "";
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(raw);
  return m ? decodeURIComponent(m[1]!) : null;
}
function sessionCookie(token: string, maxAgeSec: number): string {
  return `${COOKIE}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}
function json(res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", ...extra });
  res.end(JSON.stringify(body));
}
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8 * 1024) break;
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  if (typeof xff === "string" && xff) return xff.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}
// In-memory sliding-window limiter (single process) for the login endpoints.
const HITS = new Map<string, number[]>();
function rateLimited(key: string, limit: number, windowMs = 15 * 60_000): boolean {
  const now = Date.now();
  const arr = (HITS.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  HITS.set(key, arr);
  return arr.length > limit;
}

/** Handle a /login/*, /me/* (magic link) or /dashboard/* (app) request. */
export async function handlePanel(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  hub?: ChannelHub,
): Promise<boolean> {
  // Phone → WhatsApp OTP web login.
  if (path === "/login" || path.startsWith("/login/")) {
    return handleLogin(req, res, path, hub);
  }

  // 1) Magic login link from chat: /me/:token → set session cookie → /dashboard
  if (path === "/me" || path.startsWith("/me/")) {
    const token = path.replace(/^\/me\/?/, "").split("/")[0] ?? "";
    const userId = await userForPanelToken(token);
    if (!userId) {
      send(res, 401, expiredPage());
      return true;
    }
    const session = await createPanelSession(userId);
    const maxAge = 30 * 86_400;
    send(res, 302, "", {
      location: "/dashboard",
      "set-cookie": `${COOKIE}=${session}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
    });
    return true;
  }

  if (!path.startsWith("/dashboard")) return false;
  const parts = path.replace(/^\/dashboard\/?/, "").split("/").filter(Boolean);

  // Logout.
  if (parts[0] === "logout") {
    await destroyPanelToken(cookieToken(req));
    send(res, 302, "", { location: "/dashboard", "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
    return true;
  }

  const userId = await userForPanelToken(cookieToken(req));
  if (!userId) {
    send(res, 401, expiredPage());
    return true;
  }

  // Web chat — the AI in the browser (buffered channel, browser long-polls).
  if (parts[0] === "chat") {
    if (!hub) return send(res, 503, "Chat is unavailable right now."), true;
    if (parts[1] === "send") {
      if (req.method !== "POST") return send(res, 405, "Method not allowed"), true;
      const body = await readJsonBody(req);
      const text = String(body.text ?? "").slice(0, 4000).trim();
      if (text) {
        // Bind the web identity to THIS user so the pipeline resolves the same
        // account (same sites, credits, quota) — not a new one keyed on "web".
        await linkIdentity(userId, "web", userId).catch(() => {});
        void hub.deliverWeb(userId, text).catch((err) => log.warn({ err }, "web chat deliver failed"));
      }
      return json(res, 200, { ok: true }), true;
    }
    if (parts[1] === "poll") {
      const since = Number(new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("since")) || 0;
      return json(res, 200, hub.pollWeb(userId, since)), true;
    }
    const d = await panelData(userId);
    return send(res, 200, chatPage(d.name || d.phone || "there")), true;
  }

  // Full "Own Your Data" export (code + business data): /dashboard/export/:siteId
  // A paid perk — unlocked once the site is published (gone live).
  if (parts[0] === "export" && parts[1]) {
    const siteId = parts[1];
    if (!(await userOwnsSite(userId, siteId))) return send(res, 403, "Forbidden"), true;
    if (!(await isPublished(siteId))) return send(res, 402, lockedPage()), true;
    const zip = await buildSiteExport(siteId);
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${siteId.slice(0, 8)}-export.zip"`,
      "x-content-type-options": "nosniff",
    });
    res.end(zip);
    return true;
  }

  // Download the WHOLE site's code as one .zip: /dashboard/zip/:siteId (paid perk).
  if (parts[0] === "zip" && parts[1]) {
    const siteId = parts[1];
    if (!(await userOwnsSite(userId, siteId))) return send(res, 403, "Forbidden"), true;
    if (!(await isPublished(siteId))) return send(res, 402, lockedPage()), true;
    const files = await readSiteFiles(siteId);
    if (!files) return send(res, 404, "No code found for this site yet."), true;
    const zip = zipFiles(files);
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${siteId.slice(0, 8)}-site.zip"`,
      "x-content-type-options": "nosniff",
    });
    res.end(zip);
    return true;
  }

  // Download one page's code: /dashboard/file/:siteId?path=/index.html (paid perk).
  if (parts[0] === "file" && parts[1]) {
    const siteId = parts[1];
    if (!(await userOwnsSite(userId, siteId))) return send(res, 403, "Forbidden"), true;
    if (!(await isPublished(siteId))) return send(res, 402, lockedPage()), true;
    const files = await readSiteFiles(siteId);
    if (!files) return send(res, 404, "No code found for this site yet."), true;
    const want = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("path") ?? "/index.html";
    const html = files.get(want) ?? files.get("/index.html") ?? [...files.values()][0]!;
    const fname = `${siteId.slice(0, 8)}${want.replace(/\//g, "-").replace(/-index\.html$/, "") || "-index"}.html`;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${fname}"`,
      "x-content-type-options": "nosniff",
    });
    res.end(html);
    return true;
  }

  // The dashboard.
  try {
    const data = await panelData(userId);
    const pages = new Map<string, string[]>();
    for (const s of data.sites) {
      const files = await readSiteFiles(s.siteId).catch(() => null);
      if (files) pages.set(s.siteId, [...files.keys()].sort());
    }
    send(res, 200, dashboardPage(data, pages));
  } catch (err) {
    log.error({ err, userId }, "panel render failed");
    send(res, 500, "Something went wrong loading your dashboard. Please try again.");
  }
  return true;
}

// ── Web login (phone → WhatsApp OTP) ─────────────────────

function waLink(): string | null {
  const n = env.WHATSAPP_PUBLIC_NUMBER?.replace(/[^\d]/g, "");
  return n ? `https://wa.me/${n}?text=${encodeURIComponent("Hi, I'd like to log in to my dashboard")}` : null;
}

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  hub?: ChannelHub,
): Promise<boolean> {
  const action = path.replace(/^\/login\/?/, "").split("/").filter(Boolean)[0] ?? "";
  const ip = clientIp(req);

  if (!action) {
    if (req.method !== "GET") return send(res, 405, "Method not allowed"), true;
    if (await userForPanelToken(cookieToken(req))) return send(res, 302, "", { location: "/dashboard" }), true;
    return send(res, 200, loginPage()), true;
  }

  if (action === "send") {
    if (req.method !== "POST") return send(res, 405, "Method not allowed"), true;
    const body = await readJsonBody(req);
    const phone = normalizePhone(String(body.phone ?? ""));
    if (!phone) return json(res, 400, { ok: false, error: "invalid_phone" }), true;
    // Tight limits so nobody can spam OTPs (each WhatsApp send can cost money).
    if (rateLimited(`otp:${phone}`, 3) || rateLimited(`otpip:${ip}`, 8)) {
      return json(res, 429, { ok: false, error: "rate_limited" }), true;
    }
    if (!hub) return json(res, 200, { ok: false, needChat: true, waLink: waLink() }), true;
    const code = await createLoginOtp(phone);
    try {
      await hub.send(
        "whatsapp",
        phone,
        `Your ${BRAND.name} login code is ${code}. It expires in 5 minutes. If you didn't request this, please ignore it.`,
      );
      return json(res, 200, { ok: true }), true;
    } catch (err) {
      // Outside Meta's 24h window (or number unreachable) → tell them to message us.
      log.warn({ err: (err as Error).message }, "otp whatsapp send failed (24h window?)");
      return json(res, 200, { ok: false, needChat: true, waLink: waLink() }), true;
    }
  }

  if (action === "verify") {
    if (req.method !== "POST") return send(res, 405, "Method not allowed"), true;
    const body = await readJsonBody(req);
    const phone = normalizePhone(String(body.phone ?? ""));
    const code = String(body.code ?? "").trim();
    if (!phone || !/^\d{6}$/.test(code)) return json(res, 400, { ok: false, error: "invalid" }), true;
    if (rateLimited(`otpv:${phone}`, 10)) return json(res, 429, { ok: false, error: "rate_limited" }), true;
    if (!(await verifyLoginOtp(phone, code))) return json(res, 401, { ok: false, error: "bad_code" }), true;
    // Only NOW (proven ownership) do we resolve/create the account.
    const userId = await resolveUserId("whatsapp", phone);
    await setUserPhone(userId, phone).catch(() => {});
    const session = await createPanelSession(userId);
    return json(res, 200, { ok: true, redirect: "/dashboard" }, { "set-cookie": sessionCookie(session, 30 * 86_400) }), true;
  }

  return send(res, 404, "Not found"), true;
}

// ── Views ────────────────────────────────────────────────

function loginPage(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Log in · ${esc(BRAND.name)}</title><style>${UI_CSS}</style>${THEME_INIT}</head>
<body><div class="auth"><div style="position:fixed;top:16px;right:16px">${themeToggle()}</div>
<div class="auth-card">${logoMark(BRAND.name[0] ?? "Z", 44)}
  <div id="step1">
    <h1>Log in</h1><p class="sub">Enter your WhatsApp number and we'll send you a login code.</p>
    <label for="phone">WhatsApp number</label>
    <input id="phone" type="tel" inputmode="tel" placeholder="e.g. 234 916 946 4811" autocomplete="tel">
    <button class="btn-lg" id="sendBtn" type="button">Send my code</button>
    <p class="small" id="m1" style="margin-top:12px"></p>
  </div>
  <div id="step2" hidden>
    <h1>Enter your code</h1><p class="sub">We sent a 6-digit code to your WhatsApp. Enter it below.</p>
    <label for="code">6-digit code</label>
    <input id="code" type="text" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="one-time-code" style="letter-spacing:.35em;text-align:center;font-size:20px">
    <button class="btn-lg" id="verifyBtn" type="button">Log in</button>
    <p class="small" id="m2" style="margin-top:12px"></p>
    <p class="small muted" style="margin-top:10px"><a href="#" id="back">← Use a different number</a></p>
  </div>
</div></div>
<script>
(function(){
  var phone="", s1=document.getElementById("step1"), s2=document.getElementById("step2");
  var m1=document.getElementById("m1"), m2=document.getElementById("m2");
  function post(u,b){return fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.json().catch(function(){return{};});});}
  document.getElementById("sendBtn").addEventListener("click",function(){
    phone=document.getElementById("phone").value.trim(); m1.textContent=""; m1.className="small muted";
    if(phone.replace(/[^0-9]/g,"").length<7){m1.textContent="Please enter your full number, including country code.";return;}
    var b=this; b.disabled=true; b.textContent="Sending…";
    post("/login/send",{phone:phone}).then(function(r){
      b.disabled=false; b.textContent="Send my code";
      if(r.ok){ s1.hidden=true; s2.hidden=false; document.getElementById("code").focus(); }
      else if(r.needChat){ m1.className="small"; m1.innerHTML="We couldn't message that number yet. Please message us on WhatsApp first"+(r.waLink?(" — <a href='"+r.waLink+"' target='_blank' rel='noopener'>tap here to open the chat</a>"):"")+", then come back and try again."; }
      else if(r.error==="rate_limited"){ m1.textContent="Too many attempts — please wait a few minutes."; }
      else { m1.textContent="Please double-check the number and try again."; }
    }).catch(function(){ b.disabled=false; b.textContent="Send my code"; m1.textContent="Network error — please try again."; });
  });
  document.getElementById("verifyBtn").addEventListener("click",function(){
    var code=document.getElementById("code").value.trim(); m2.textContent="";
    if(!/^\\d{6}$/.test(code)){m2.className="small";m2.textContent="Enter the 6-digit code.";return;}
    var b=this; b.disabled=true; b.textContent="Logging in…";
    post("/login/verify",{phone:phone,code:code}).then(function(r){
      if(r.ok&&r.redirect){ location.href=r.redirect; return; }
      b.disabled=false; b.textContent="Log in"; m2.className="small";
      m2.textContent = r.error==="bad_code" ? "That code is wrong or has expired. Please try again." : (r.error==="rate_limited"?"Too many tries — please wait a bit.":"Something went wrong. Please try again.");
    }).catch(function(){ b.disabled=false; b.textContent="Log in"; m2.textContent="Network error — please try again."; });
  });
  document.getElementById("back").addEventListener("click",function(e){e.preventDefault(); s2.hidden=true; s1.hidden=false;});
})();
</script>
</body></html>`;
}

function chatPage(name: string): string {
  const body = `
  <style>
    .chatwrap{display:flex;flex-direction:column;height:calc(100vh - 150px);min-height:440px}
    .msgs{flex:1;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:10px}
    .bub{max-width:78%;padding:10px 14px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;font-size:14px;line-height:1.5}
    .bub.you{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:4px}
    .bub.ai{align-self:flex-start;background:var(--bg2);border:1px solid var(--line);border-bottom-left-radius:4px}
    .acts{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start;margin-top:-4px}
    .bar{border-top:1px solid var(--line);padding:12px;display:flex;gap:8px}
    .bar input{flex:1}
    .typing{align-self:flex-start;color:var(--muted);font-size:13px;padding:2px 6px}
  </style>
  <div class="panel chatwrap">
    <div class="msgs" id="msgs"></div>
    <div class="bar">
      <input id="inp" placeholder="Describe a website, or ask for a change…" autocomplete="off">
      <button class="btn" id="sendBtn">${icon("spark", 15)} Send</button>
    </div>
  </div>
  <script>
  (function(){
    var cursor=0, first=true, msgs=document.getElementById("msgs"), inp=document.getElementById("inp"), btn=document.getElementById("sendBtn");
    var WELCOME="Hi! 👋 Tell me what you'd like to build — or ask me to change a site you already have. For example: \\"Build me a bakery website with a menu and contact form.\\"";
    function scroll(){ msgs.scrollTop = msgs.scrollHeight; }
    function bubble(text, who){ var d=document.createElement("div"); d.className="bub "+who; d.textContent=text; msgs.appendChild(d); scroll(); }
    function actionRow(actions){
      var row=document.createElement("div"); row.className="acts";
      actions.forEach(function(a){ var b=document.createElement("button"); b.className="btn ghost sm"; b.textContent=a.label; b.onclick=function(){ sendText(a.id); }; row.appendChild(b); });
      msgs.appendChild(row); scroll();
    }
    function render(m){ bubble(m.text, m.role==="user"?"you":"ai"); if(m.role!=="user" && m.actions && m.actions.length) actionRow(m.actions); }
    function sendText(text){
      if(!text) return;
      fetch("/dashboard/chat/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:text})}).catch(function(){});
      setTimeout(poll,120); // show my message (buffered server-side) right away
    }
    function sendInput(){ var t=inp.value.trim(); if(!t) return; inp.value=""; sendText(t); }
    function poll(){
      fetch("/dashboard/chat/poll?since="+cursor).then(function(r){return r.json();}).then(function(d){
        if(first){ first=false; if(!(d.messages&&d.messages.length)) bubble(WELCOME,"ai"); }
        cursor = d.cursor || cursor;
        (d.messages||[]).forEach(render);
      }).catch(function(){});
    }
    btn.onclick=sendInput;
    inp.addEventListener("keydown",function(e){ if(e.key==="Enter"){ e.preventDefault(); sendInput(); } });
    poll(); setInterval(poll, 2000);
    inp.focus();
  })();
  </script>`;
  return shell("Chat with AI", name, "/dashboard/chat", body);
}

function shell(title: string, name: string, active: string, body: string): string {
  const nav = [
    ["/dashboard#overview", "grid", "Overview"],
    ["/dashboard/chat", "chat", "Chat with AI"],
    ["/dashboard#sites", "globe", "My sites"],
    ["/dashboard#analytics", "activity", "Analytics"],
    ["/dashboard#sales", "wallet", "Sales"],
    ["/dashboard#domains", "link", "Domains"],
    ["/dashboard#billing", "wallet", "Billing"],
    ["/dashboard#account", "user", "Account"],
  ]
    .map(
      ([href, ic, label]) =>
        `<a class="nav-item ${active === href ? "on" : ""}" href="${href}">${icon(ic!)}<span>${label}</span></a>`,
    )
    .join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(BRAND.name)}</title><style>${UI_CSS}</style>${THEME_INIT}</head>
<body><div class="app">
<aside class="side">
  <div class="side-brand">${logoMark(BRAND.name[0] ?? "Z")}<div>${esc(BRAND.name)}<br><small>My dashboard</small></div></div>
  <nav class="nav"><div class="nav-label">Menu</div>${nav}</nav>
  <div class="side-foot">
    <a class="nav-item" href="/dashboard/logout">${icon("logout")}<span>Sign out</span></a>
  </div>
</aside>
<div class="main">
  <header class="topbar">
    <div><h1>${esc(title)}</h1><div class="crumb">Your sites, code and account</div></div>
    <div class="who">${themeToggle()}<div class="chip"><span class="avatar">${esc(initials(name))}</span>
      <span><span class="who-name">${esc(name)}</span><br><span class="who-sub">Customer</span></span></div></div>
  </header>
  <div class="content">${body}</div>
</div></div></body></html>`;
}

function expiredPage(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Link expired · ${esc(BRAND.name)}</title><style>${UI_CSS}</style>${THEME_INIT}</head>
<body><div class="auth"><div style="position:fixed;top:16px;right:16px">${themeToggle()}</div>
<div class="auth-card">${logoMark(BRAND.name[0] ?? "Z", 44)}
<h1>Please sign in again</h1>
<p class="sub">For your security, sessions expire after a while. Log in with your WhatsApp number, or message ${esc(
    BRAND.name,
  )} on chat and say <b>"my dashboard"</b> for a private link.</p>
<a class="btn-lg" href="/login" style="display:inline-block;width:100%;text-align:center">Log in with WhatsApp</a></div></div></body></html>`;
}

function statusTag(s: PanelSite): string {
  if (s.suspended) return `<span class="pill bad"><span class="dot"></span>suspended</span>`;
  if (s.published) return `<span class="pill ok"><span class="dot"></span>live</span>`;
  return `<span class="pill mute"><span class="dot"></span>preview</span>`;
}

/** Shown when a customer hits a download/export link for a site that isn't live yet. */
function lockedPage(): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Publish to unlock</title>
  <div style="font-family:system-ui,sans-serif;max-width:460px;margin:14vh auto;padding:0 22px;text-align:center;color:#1a1a1a">
    <div style="font-size:44px">🔒</div>
    <h2 style="margin:.4em 0">Export is a published-site perk</h2>
    <p style="color:#555;line-height:1.55">Downloading your code and business-data export unlocks once this site is <b>live</b>.
    Publish it (in chat, say <b>"publish my site"</b>) and this button turns on right away.</p>
    <p><a href="/dashboard" style="color:#4f46e5;font-weight:600;text-decoration:none">← Back to your dashboard</a></p>
  </div>`;
}

function siteCard(s: PanelSite, pages: string[]): string {
  const name = s.url ? s.url.replace(/^https?:\/\//, "") : `Building…`;
  const plan = `<span class="pill info">${s.plan === "dynamic" ? "dashboard" : "static"}</span>`;
  const backend = s.backendOn
    ? `<span class="pill ok">${s.endUsers} user${s.endUsers === 1 ? "" : "s"} · ${s.records} record${s.records === 1 ? "" : "s"}</span>`
    : "";
  const open = s.url ? `<a class="btn ghost sm" href="${esc(s.url)}" target="_blank" rel="noopener">${icon("globe", 15)} Open</a>` : "";
  let dl: string;
  if (!pages.length) {
    dl = `<div class="small muted" style="margin-top:12px">Code appears here once the site finishes building.</div>`;
  } else if (!s.published) {
    // Paid perk: export unlocks when the site goes live. View-source is still free.
    dl = `<div class="row small" style="margin-top:12px">${icon("lock", 15)}<span class="muted">Publish this site to download your code + data export.</span></div>`;
  } else {
    dl = `<div class="row small" style="margin-top:12px">${icon("download", 15)}<span class="muted">Export:</span>
        <a class="btn sm" href="/dashboard/export/${esc(s.siteId)}">${icon("download", 14)} Everything (code + data)</a>
        <a class="btn ghost sm" href="/dashboard/zip/${esc(s.siteId)}">${icon("download", 14)} Code only</a></div>
      <div class="row small" style="margin-top:6px"><span class="muted">Pages:</span>
        ${pages
          .map(
            (p) =>
              `<a href="/dashboard/file/${esc(s.siteId)}?path=${encodeURIComponent(p)}">${esc(
                p === "/index.html" ? "home" : p.replace(/\/index\.html$/, "").replace(/^\//, ""),
              )}</a>`,
          )
          .join(" · ")}</div>`;
  }
  return `<div class="card">
    <div class="spread"><div class="row">${logoMark((name[0] ?? "S").toUpperCase(), 34)}<b>${esc(name)}</b></div>${open}</div>
    <div class="row" style="margin-top:12px">${statusTag(s)}${plan}${backend}</div>
    ${dl}</div>`;
}

function orderRow(o: PanelOrder): string {
  const tag = o.status === "paid" ? `<span class="pill ok">paid</span>` : `<span class="pill mute">${esc(o.status)}</span>`;
  return `<tr><td><b>${esc(o.currency)} ${o.amount.toLocaleString()}</b></td><td>${tag}</td><td class="small">${esc(o.buyer ?? "—")}</td></tr>`;
}

function salesPanel(d: PanelData): string {
  if (!d.sales.orders) {
    return `<div class="panel"><div class="empty">${icon("wallet", 38)}<div>No sales yet. In chat, say <b>"connect payment"</b> to link your account, then <b>"add product …"</b> — buyers pay you directly.</div></div></div>`;
  }
  return `<div class="panel">
    <div class="hd">Orders <span class="sub">${d.sales.currency} ${d.sales.revenue.toLocaleString()} from ${d.sales.paid} paid</span></div>
    <div class="tablewrap"><table><thead><tr><th>Amount</th><th>Status</th><th>Buyer</th></tr></thead>
    <tbody>${d.recentOrders.map(orderRow).join("")}</tbody></table></div></div>`;
}

function barChart(series: PanelData["traffic"]["series"]): string {
  if (!series.length) {
    return `<p class="small muted" style="padding:16px">No visits yet — share your site link and traffic will show here.</p>`;
  }
  const max = Math.max(...series.map((s) => s.views), 1);
  const bars = series
    .map((s) => {
      const h = Math.max(2, Math.round((s.views / max) * 100));
      return `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:6px" title="${s.views} views">
        <div style="width:62%;height:${h}%;min-height:3px;background:linear-gradient(180deg,var(--accent),var(--accent2));border-radius:5px 5px 0 0"></div>
        <div class="small muted" style="font-size:10px">${esc(s.day.slice(5))}</div></div>`;
    })
    .join("");
  return `<div style="display:flex;gap:6px;align-items:flex-end;height:130px;padding:18px">${bars}</div>`;
}

function analyticsPanel(d: PanelData): string {
  const t = d.traffic;
  const topPages = t.topPages.length
    ? `<div class="tablewrap"><table><thead><tr><th>Page</th><th>Views</th></tr></thead><tbody>${t.topPages
        .map((p) => `<tr><td class="mono">${esc(p.path)}</td><td>${p.views}</td></tr>`)
        .join("")}</tbody></table></div>`
    : "";
  return `<div class="panel"><div class="hd">Traffic — last 7 days <span class="sub">${t.views} views · ${t.visitors} visitor${t.visitors === 1 ? "" : "s"}</span></div>${barChart(t.series)}${topPages}</div>`;
}

function dashboardPage(d: PanelData, pages: Map<string, string[]>): string {
  const name = d.name || d.phone || "there";
  const sites = d.sites.length
    ? `<div class="grid2">${d.sites.map((s) => siteCard(s, pages.get(s.siteId) ?? [])).join("")}</div>`
    : `<div class="panel"><div class="empty">${icon("globe", 38)}<div>No sites yet — describe one to ${esc(
        BRAND.name,
      )} in chat and it'll appear here.</div></div></div>`;
  const domains = d.domains.length
    ? `<div class="panel"><div class="hd">Domains</div><div class="tablewrap"><table><thead><tr><th>Domain</th><th>Status</th><th>Renews</th></tr></thead><tbody>${d.domains
        .map(
          (dm) =>
            `<tr><td class="mono">${esc(dm.name)}</td><td><span class="pill ${
              dm.status === "registered" ? "ok" : "mute"
            }">${esc(dm.status)}</span></td><td class="small muted">${dm.expiry ? esc(dm.expiry) : "—"}</td></tr>`,
        )
        .join("")}</tbody></table></div></div>`
    : `<div class="panel"><div class="empty">${icon("link", 38)}<div>No domains yet. Ask ${esc(
        BRAND.name,
      )} in chat to connect one you own, or find you a new one.</div></div></div>`;

  return shell(
    `Hi ${name} 👋`,
    name,
    "/dashboard#overview",
    `<div id="overview" class="cards">
       <div class="card"><div class="k">${icon("activity", 15)} Visitors (7d)</div><div class="v">${d.traffic.visitors}</div><div class="s">${d.traffic.views} page views</div></div>
       <div class="card"><div class="k">${icon("wallet", 15)} Sales revenue</div><div class="v">${esc(d.sales.currency)} ${d.sales.revenue.toLocaleString()}</div><div class="s">${d.sales.paid} paid order${d.sales.paid === 1 ? "" : "s"}</div></div>
       <div class="card"><div class="k">${icon("globe", 15)} Sites</div><div class="v">${d.sites.length}</div><div class="s">${d.sites.filter((s) => s.published).length} live</div></div>
       <div class="card"><div class="k">${icon("wallet", 15)} Credits</div><div class="v">${d.credits}</div><div class="s">for edits & extras</div></div>
     </div>

     <div id="sites"><h2>My sites</h2>${sites}</div>
     <div id="analytics"><h2>Analytics</h2>${analyticsPanel(d)}</div>
     <div id="sales"><h2>Sales</h2>${salesPanel(d)}</div>
     <div id="domains"><h2>Domains</h2>${domains}</div>

     <div id="billing"><h2>Billing</h2>
       <div class="panel"><div class="hd">Credit balance <span class="sub">Top up or manage in chat</span></div>
         <div style="padding:18px"><div class="row"><div class="v" style="font-size:32px;font-weight:750">${d.credits}</div><span class="muted">credits</span></div>
         <p class="small muted" style="margin:10px 0 0">Say <b>"top up"</b> in chat to add credits, or <b>"my balance"</b> anytime. Publishing a site is a one-time yearly fee — no monthly surprises.</p></div></div>
     </div>

     <div id="account"><h2>Account</h2>
       <div class="panel"><div class="hd">Your details</div>
         <div class="tablewrap"><table><tbody>
           <tr><td class="muted" style="width:140px">Name</td><td>${esc(d.name ?? "—")}</td></tr>
           <tr><td class="muted">Phone</td><td class="mono">${esc(d.phone ?? "—")}</td></tr>
           <tr><td class="muted">Email</td><td class="mono">${esc(d.email ?? "—")}</td></tr>
         </tbody></table></div></div>
       <div class="panel"><div class="hd">Need help?</div>
         <div style="padding:18px" class="small">Message ${esc(BRAND.name)} in chat for any change — an edit, your site link, a top-up, a new domain, or say <b>"talk to a human"</b>. Your code is yours to keep; we host + maintain your site while your plan is active.</div></div>
     </div>`,
  );
}
