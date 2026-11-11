import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../lib/logger.js";
import {
  activeOwnerCount,
  createStaff,
  listStaff,
  login,
  logout,
  purgeExpiredSessions,
  setStaffActive,
  setStaffPassword,
  setStaffRole,
  staffCount,
  staffForToken,
  type Staff,
} from "./auth.js";
import { audit, recentAudit } from "./audit.js";
import { can, isRole, capabilitiesFor, ROLE_DESCRIPTION, type Capability } from "./roles.js";
import { customers, jobs, overview, siteOwners, publishInfo, backendInfo, fraudFlags } from "./data.js";
import { allHosting } from "../launch/hosting-store.js";
import { suspendSite, restoreSite } from "../launch/deploy.js";
import { recentSubmissions } from "../forms/store.js";
import { grant, getBalance } from "../billing/credits.js";
import { setUserLimit } from "../billing/quota.js";
import { allSettings, getNum, isSettingKey, labelOf, setNum } from "../config/settings.js";
import {
  A,
  card,
  esc,
  layout,
  loginPage,
  panel,
  roleOptions,
  setupPage,
  table,
  when,
} from "./views.js";
import {
  clientIp,
  guardSummary,
  ipAllowed,
  loginLocked,
  recordFailure,
  recordSuccess,
} from "./guard.js";

const log = logger.child({ mod: "admin" });

// ── Tiny HTTP helpers ────────────────────────────────────

function html(res: ServerResponse, body: string, code = 200): void {
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(302, { location: to, "cache-control": "no-store" });
  res.end();
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res: ServerResponse, token: string | null): void {
  const secure = (process.env["PUBLIC_BASE_URL"] ?? "").startsWith("https") ? " Secure;" : "";
  res.setHeader(
    "set-cookie",
    token
      ? `zadmin=${token}; HttpOnly; SameSite=Strict; Path=${A}; Max-Age=${7 * 86400};${secure}`
      : `zadmin=; HttpOnly; SameSite=Strict; Path=${A}; Max-Age=0;${secure}`,
  );
}

async function body(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) break;
    chunks.push(c as Buffer);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))) {
    out[k] = v;
  }
  return out;
}

/** Flash messages travel in the query string (?ok=... / ?err=...). */
function flashOf(q: URLSearchParams): { kind: "ok" | "err"; text: string } | null {
  const ok = q.get("ok");
  if (ok) return { kind: "ok", text: ok };
  const err = q.get("err");
  if (err) return { kind: "err", text: err };
  return null;
}

const back = (path: string, kind: "ok" | "err", msg: string) =>
  `${path}?${kind}=${encodeURIComponent(msg)}`;

// ── Router ───────────────────────────────────────────────

export async function handleAdmin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? A, "http://local");
  const path = url.pathname.replace(/\/+$/, "") || A;
  const q = url.searchParams;
  const method = req.method ?? "GET";
  const ip = clientIp(req);

  // IP allowlist (when configured): anything else gets a plain 404 — the panel
  // simply doesn't appear to exist.
  if (!ipAllowed(ip)) {
    log.warn({ ip, path }, "admin blocked: IP not allowlisted");
    html(res, "Not found", 404);
    return;
  }

  // First-run: no staff yet → force owner creation.
  if ((await staffCount()) === 0) {
    if (path === `${A}/setup` && method === "POST") {
      const f = await body(req);
      const email = (f["email"] ?? "").trim().toLowerCase();
      const password = f["password"] ?? "";
      if (!email || password.length < 10) {
        html(res, setupPage("Enter an email and a password of at least 10 characters."));
        return;
      }
      const staff = await createStaff({ email, name: f["name"] ?? null, password, role: "owner" });
      if (!staff) {
        html(res, setupPage("That email is already registered."));
        return;
      }
      await audit(email, "staff.setup", staff.id, { role: "owner" });
      redirect(res, `${A}/login?ok=Owner+account+created.+Please+sign+in.`);
      return;
    }
    html(res, setupPage());
    return;
  }

  // Login / logout.
  if (path === `${A}/login`) {
    if (method === "POST") {
      const f = await body(req);
      const email = f["email"] ?? "";
      // Brute-force lockout: keyed on BOTH the IP and the account, so neither
      // spraying many accounts from one IP nor one account from many IPs gets
      // unlimited guesses.
      const locked = loginLocked(ip, email);
      if (locked > 0) {
        log.warn({ ip, email }, "admin login attempt while locked out");
        html(
          res,
          loginPage(
            `Too many failed attempts. Try again in ${Math.ceil(locked / 60)} minute(s).`,
          ),
        );
        return;
      }
      const token = await login(email, f["password"] ?? "");
      if (!token) {
        recordFailure(ip, email);
        // Deliberately vague: never reveal whether the account exists.
        html(res, loginPage("Wrong email or password, or the account is disabled."));
        return;
      }
      recordSuccess(ip, email);
      setCookie(res, token);
      redirect(res, A);
      return;
    }
    html(res, loginPage(q.get("err") ?? undefined, q.get("ok") ?? undefined));
    return;
  }

  const token = cookies(req)["zadmin"] ?? null;
  const me = await staffForToken(token);

  if (path === `${A}/logout`) {
    if (token) await logout(token);
    setCookie(res, null);
    redirect(res, `${A}/login`);
    return;
  }

  if (!me) {
    redirect(res, `${A}/login`);
    return;
  }

  // Capability gate for every route below.
  const need = (cap: Capability): boolean => {
    if (can(me.role, cap)) return true;
    redirect(res, back(A, "err", "You don't have permission for that."));
    return false;
  };

  const page = (title: string, bodyHtml: string) =>
    html(
      res,
      layout({
        title,
        path,
        role: me.role,
        email: me.email,
        body: bodyHtml,
        flash: flashOf(q),
      }),
    );

  try {
    switch (true) {
      case path === A:
        return await dashboard(page, me);
      case path === `${A}/sites`:
        return need("sites.view") ? await sitesPage(page, me) : undefined;
      case path === `${A}/sites/suspend` && method === "POST":
        return need("sites.suspend") ? await doSuspend(req, res, me) : undefined;
      case path === `${A}/sites/restore` && method === "POST":
        return need("sites.suspend") ? await doRestore(req, res, me) : undefined;
      case path === `${A}/customers`:
        return need("customers.view") ? await customersPage(page, me, q) : undefined;
      case path === `${A}/customers/credits` && method === "POST":
        return need("customers.credits") ? await doCredits(req, res, me) : undefined;
      case path === `${A}/customers/limit` && method === "POST":
        return need("customers.limits") ? await doLimit(req, res, me) : undefined;
      case path === `${A}/submissions`:
        return need("submissions.view") ? await submissionsPage(page) : undefined;
      case path === `${A}/jobs`:
        return need("jobs.view") ? await jobsPage(page, q) : undefined;
      case path === `${A}/revenue`:
        return need("revenue.view") ? await revenuePage(page) : undefined;
      case path === `${A}/security`:
        return need("revenue.view") ? await securityPage(page) : undefined;
      case path === `${A}/settings`:
        return need("settings.view") ? await settingsPage(page, me) : undefined;
      case path === `${A}/settings/save` && method === "POST":
        return need("settings.edit") ? await doSettings(req, res, me) : undefined;
      case path === `${A}/staff`:
        return need("staff.view") ? await staffPage(page, me) : undefined;
      case path === `${A}/staff/create` && method === "POST":
        return need("staff.manage") ? await doStaffCreate(req, res, me) : undefined;
      case path === `${A}/staff/role` && method === "POST":
        return need("staff.manage") ? await doStaffRole(req, res, me) : undefined;
      case path === `${A}/staff/active` && method === "POST":
        return need("staff.manage") ? await doStaffActive(req, res, me) : undefined;
      case path === `${A}/staff/password` && method === "POST":
        return need("staff.manage") ? await doStaffPassword(req, res, me) : undefined;
      case path === `${A}/audit`:
        return need("audit.view") ? await auditPage(page) : undefined;
      default:
        html(res, "Not found", 404);
    }
  } catch (err) {
    log.error({ err, path }, "admin route failed");
    if (!res.headersSent) redirect(res, back(A, "err", "Something went wrong."));
  }
}

type Page = (title: string, body: string) => void;

// ── Pages ────────────────────────────────────────────────

async function dashboard(page: Page, me: Staff): Promise<void> {
  const o = await overview();
  const caps = capabilitiesFor(me.role);
  const cards = [
    card("Customers", o.customers),
    card("Live sites", o.sitesLive, o.sitesSuspended ? `${o.sitesSuspended} suspended` : ""),
    card("Published", o.publishedSites, "paid & live"),
    card("Builds (24h)", o.buildsToday, o.buildsFailedToday ? `${o.buildsFailedToday} failed` : "all healthy"),
    card("Enquiries", o.submissions, "from customer sites"),
    caps.includes("revenue.view") ? card("Publish revenue (NGN)", `₦${o.publishRevenueNgn.toLocaleString("en-NG")}`, `${o.publishesPaid} published`) : "",
    caps.includes("revenue.view") ? card("Top-ups (NGN)", `₦${o.revenueNgn.toLocaleString("en-NG")}`, `${o.topupsPaid} paid`) : "",
    card("Credits outstanding", o.creditsOutstanding, "customer wallets"),
  ]
    .filter(Boolean)
    .join("");

  const yourCaps = caps.map((c) => `<span>${esc(c)}</span>`).join("");
  const bodyHtml = `<div class="cards">${cards}</div>
  ${panel(
    "Your access",
    `<div style="padding:1rem 1.1rem"><div class="small muted">${esc(
      ROLE_DESCRIPTION[me.role],
    )}</div><div class="caps">${yourCaps}</div></div>`,
  )}`;
  page("Dashboard", bodyHtml);
}

async function sitesPage(page: Page, me: Staff): Promise<void> {
  const [sites, owners, pub, be] = await Promise.all([
    allHosting(),
    siteOwners(),
    publishInfo(),
    backendInfo(),
  ]);
  const mayKill = can(me.role, "sites.suspend");
  const rows = sites.map((s) => {
    const status = s.suspended
      ? `<span class="tag bad">suspended</span>`
      : `<span class="tag ok">live</span>`;
    const p = pub[s.siteId];
    const plan = p?.plan === "dynamic" ? `<span class="tag warn">dashboard</span>` : `<span class="tag mute">static</span>`;
    const publish = p?.published
      ? `<span class="tag ok">published</span>${p.until ? `<div class="small muted">till ${when(p.until)}</div>` : ""}`
      : `<span class="tag mute">preview</span>`;
    const b = be[s.siteId];
    const backend = b
      ? `<span class="tag ok">on</span><div class="small muted">${b.users} user${b.users === 1 ? "" : "s"} · ${b.records} rec</div>`
      : `<span class="tag mute">—</span>`;
    const action = !mayKill
      ? ""
      : s.suspended
        ? `<form method="POST" action="${A}/sites/restore" class="inline">
             <input type="hidden" name="siteId" value="${esc(s.siteId)}">
             <button class="good">Restore</button></form>`
        : `<form method="POST" action="${A}/sites/suspend" class="inline"
             onsubmit="return confirm('Take this site OFFLINE now? Other sites are unaffected.')">
             <input type="hidden" name="siteId" value="${esc(s.siteId)}">
             <input name="reason" placeholder="reason" style="width:9rem">
             <button class="danger">Suspend</button></form>`;
    return `<tr>
      <td class="wrap"><a href="${esc(s.publicUrl)}" target="_blank" rel="noopener">${esc(
        s.publicUrl.replace(/^https?:\/\//, ""),
      )}</a>${s.suspendedReason ? `<div class="small muted">${esc(s.suspendedReason)}</div>` : ""}</td>
      <td>${status}</td>
      <td>${plan}</td>
      <td>${publish}</td>
      <td>${backend}</td>
      <td class="small muted">${esc(s.provider)}</td>
      <td class="small mono">${esc(owners[s.siteId] ?? "—")}</td>
      <td>${action}</td></tr>`;
  });
  page(
    "Sites",
    panel(
      `${sites.length} hosted site${sites.length === 1 ? "" : "s"}`,
      table(
        ["Site", "Status", "Plan", "Publish", "Backend", "Host", "Owner", mayKill ? "Kill switch" : ""],
        rows,
      ),
      `<span class="small muted">Preview = free; Published = paid annual fee</span>`,
    ),
  );
}

async function customersPage(page: Page, me: Staff, q: URLSearchParams): Promise<void> {
  const search = q.get("q") ?? "";
  const list = await customers(100, search);
  const mayCredit = can(me.role, "customers.credits");
  const mayLimit = can(me.role, "customers.limits");
  const rows = list.map((c) => {
    const credit = mayCredit
      ? `<form method="POST" action="${A}/customers/credits" class="inline">
           <input type="hidden" name="userId" value="${esc(c.userId)}">
           <input name="amount" type="number" min="1" placeholder="+credits" style="width:6.5rem">
           <button class="ghost">Grant</button></form>`
      : "";
    const limit = mayLimit
      ? `<form method="POST" action="${A}/customers/limit" class="inline">
           <input type="hidden" name="userId" value="${esc(c.userId)}">
           <input name="limit" placeholder="n / unlimited" style="width:8rem">
           <button class="ghost">Set</button></form>`
      : "";
    return `<tr>
      <td class="wrap mono">${esc(c.identities)}</td>
      <td><b>${c.credits}</b></td>
      <td>${c.sites}</td>
      <td class="small muted">${c.buildsUsed} builds · ${c.editsUsed} edits</td>
      <td class="small">${c.buildLimit === null ? "default" : c.buildLimit === -1 ? "unlimited" : c.buildLimit}</td>
      <td class="small muted">${when(c.createdAt)}</td>
      <td>${credit}${limit ? ` ${limit}` : ""}</td></tr>`;
  });
  const searchBox = `<form method="GET" action="${A}/customers" class="inline">
    <input name="q" value="${esc(search)}" placeholder="search identity…" style="width:12rem">
    <button class="ghost">Search</button></form>`;
  page(
    "Customers",
    panel(`${list.length} customer${list.length === 1 ? "" : "s"}`, table(
      ["Identity", "Credits", "Sites", "Usage", "Site limit", "Joined", "Actions"],
      rows,
    ), searchBox),
  );
}

async function submissionsPage(page: Page): Promise<void> {
  const subs = await recentSubmissions(150);
  const rows = subs.map((s) => {
    const fields = Object.entries(s.data)
      .map(([k, v]) => `<b>${esc(k)}:</b> ${esc(String(v).slice(0, 120))}`)
      .join("<br>");
    return `<tr><td class="small muted">${when(s.createdAt)}</td>
      <td class="small mono">${esc(s.siteId.slice(0, 8))}</td>
      <td class="small">${esc(s.formName ?? "—")}</td>
      <td class="wrap small">${fields}</td></tr>`;
  });
  page(
    "Enquiries",
    panel(
      `${subs.length} submission${subs.length === 1 ? "" : "s"} from customer websites`,
      table(["When", "Site", "Form", "Details"], rows),
    ),
  );
}

async function jobsPage(page: Page, q: URLSearchParams): Promise<void> {
  const state = q.get("state") ?? "";
  const list = await jobs(150, state);
  const rows = list.map((j) => {
    const tag =
      j.state === "completed" || j.state === "awaiting_approval"
        ? `<span class="tag ok">${esc(j.state)}</span>`
        : j.state === "failed"
          ? `<span class="tag bad">failed</span>`
          : `<span class="tag warn">${esc(j.state)}</span>`;
    return `<tr><td class="small muted">${when(j.createdAt)}</td>
      <td>${esc(j.type)}</td><td>${tag}</td>
      <td class="small mono">${esc((j.siteId ?? "—").slice(0, 8))}</td>
      <td class="small mono">${esc(j.chatId ?? "—")}</td>
      <td class="small">$${j.costUsd.toFixed(4)}</td>
      <td class="wrap small muted">${esc(j.error ?? "")}</td></tr>`;
  });
  const filter = `<form method="GET" action="${A}/jobs" class="inline">
    <select name="state"><option value="">all states</option>
    ${["queued", "running", "awaiting_approval", "completed", "failed"]
      .map((s) => `<option value="${s}"${s === state ? " selected" : ""}>${s}</option>`)
      .join("")}
    </select><button class="ghost">Filter</button></form>`;
  page("Builds", panel(`${list.length} recent jobs`, table(
    ["When", "Type", "State", "Site", "Chat", "Cost", "Error"],
    rows,
  ), filter));
}

async function securityPage(page: Page): Promise<void> {
  const flags = await fraudFlags(200);
  const rows = flags.map((f) => {
    const tag =
      f.action === "block"
        ? `<span class="tag bad">blocked</span>`
        : `<span class="tag warn">review</span>`;
    return `<tr><td class="small muted">${when(f.createdAt)}</td>
      <td>${tag}</td>
      <td class="small">${f.score}</td>
      <td class="small mono">${esc((f.userId ?? "—").slice(0, 8))}</td>
      <td class="small mono">${esc(f.txRef ?? "—")}</td>
      <td class="wrap small muted">${esc(f.reasons)}</td></tr>`;
  });
  page(
    "Security",
    panel(
      flags.length ? `${flags.length} flagged payment attempt(s)` : "No fraud flags — all clear",
      table(["When", "Action", "Score", "User", "Tx ref", "Signals"], rows),
      `<div style="padding:1rem 1.1rem" class="small muted">
       Payment attempts are scored for card-testing / farming <b>before</b> a checkout is created.
       Crediting itself is always verified against the payment provider, so a flag here never
       affects a real, confirmed payment — it's an early-warning trail. Only an extreme velocity
       score (≥80) pauses new checkouts briefly; everything else is logged for you to review.</div>`,
    ),
  );
}

async function revenuePage(page: Page): Promise<void> {
  const o = await overview();
  const cards = [
    card("Publish revenue (NGN)", `₦${o.publishRevenueNgn.toLocaleString("en-NG")}`, "annual host + domain"),
    card("Publish revenue (USD)", `$${o.publishRevenueUsd.toLocaleString()}`),
    card("Sites published", o.publishedSites, `${o.publishesPaid} paid`),
    card("Top-up revenue (NGN)", `₦${o.revenueNgn.toLocaleString("en-NG")}`, "edit credits"),
    card("Top-up revenue (USD)", `$${o.revenueUsd.toLocaleString()}`),
    card("Paid top-ups", o.topupsPaid),
    card("Credits outstanding", o.creditsOutstanding, "unspent customer credits"),
  ].join("");
  page(
    "Revenue",
    `<div class="cards">${cards}</div>
     ${panel(
       "How this is counted",
       `<div style="padding:1rem 1.1rem" class="small muted">
        Two revenue streams: <b>publish</b> = the annual host+domain fee paid to take a site live;
        <b>top-ups</b> = credits customers buy for edits. Both count confirmed payments only
        (status <b>paid</b>). Credits outstanding is money customers paid but haven't spent — a
        liability, not profit.</div>`,
     )}`,
  );
}

async function settingsPage(page: Page, me: Staff): Promise<void> {
  const editable = can(me.role, "settings.edit");
  const rows = allSettings().map(
    (s) => `<tr><td><b>${esc(s.key)}</b><div class="small muted">${esc(s.label)}</div></td>
      <td>${
        editable
          ? `<form method="POST" action="${A}/settings/save" class="inline">
               <input type="hidden" name="key" value="${esc(s.key)}">
               <input name="value" type="number" min="0" value="${s.value}" style="width:7rem">
               <button>Save</button></form>`
          : `<b>${s.value}</b>`
      }</td></tr>`,
  );
  page(
    "Settings",
    panel(
      "Pricing & limits",
      table(["Setting", editable ? "Value" : "Current"], rows),
      editable ? `<span class="small muted">Applies to every customer immediately</span>` : `<span class="tag mute">read-only</span>`,
    ),
  );
}

async function staffPage(page: Page, me: Staff): Promise<void> {
  const list = await listStaff();
  const mayManage = can(me.role, "staff.manage");
  const rows = list.map((s) => {
    const isMe = s.id === me.id;
    const roleForm = mayManage && !isMe
      ? `<form method="POST" action="${A}/staff/role" class="inline">
           <input type="hidden" name="id" value="${esc(s.id)}">
           <select name="role" style="max-width:11rem">${roleOptions(s.role)}</select>
           <button class="ghost">Save</button></form>`
      : `<span class="tag mute">${esc(s.role)}</span>`;
    const activeForm = mayManage && !isMe
      ? `<form method="POST" action="${A}/staff/active" class="inline">
           <input type="hidden" name="id" value="${esc(s.id)}">
           <input type="hidden" name="active" value="${s.active ? "0" : "1"}">
           <button class="${s.active ? "danger" : "good"}">${s.active ? "Disable" : "Enable"}</button></form>`
      : "";
    const pwForm = mayManage
      ? `<form method="POST" action="${A}/staff/password" class="inline">
           <input type="hidden" name="id" value="${esc(s.id)}">
           <input name="password" type="password" placeholder="new password" style="width:9rem" minlength="10">
           <button class="ghost">Reset</button></form>`
      : "";
    return `<tr>
      <td>${esc(s.name ?? "—")}${isMe ? ` <span class="tag mute">you</span>` : ""}<div class="small muted">${esc(s.email)}</div></td>
      <td>${roleForm}</td>
      <td>${s.active ? `<span class="tag ok">active</span>` : `<span class="tag bad">disabled</span>`}</td>
      <td class="small muted">${s.lastLoginAt ? when(s.lastLoginAt) : "never"}</td>
      <td>${activeForm} ${pwForm}</td></tr>`;
  });

  const addForm = mayManage
    ? panel(
        "Add a team member",
        `<form method="POST" action="${A}/staff/create" style="padding:1rem 1.1rem" class="row">
          <input name="name" placeholder="Name" required>
          <input name="email" type="email" placeholder="Email" required>
          <input name="password" type="password" placeholder="Temp password (10+)" minlength="10" required>
          <select name="role">${roleOptions("spectator")}</select>
          <button type="submit">Create account</button>
        </form>`,
      )
    : "";

  page(
    "Staff",
    `${panel(`${list.length} team member${list.length === 1 ? "" : "s"}`, table(
      ["Person", "Role", "Status", "Last login", "Actions"],
      rows,
    ))}${addForm}`,
  );
}

async function auditPage(page: Page): Promise<void> {
  const entries = await recentAudit(200);
  const rows = entries.map(
    (e) => `<tr><td class="small muted">${when(e.createdAt)}</td>
      <td class="small">${esc(e.actor ?? "—")}</td>
      <td><span class="tag mute">${esc(e.action)}</span></td>
      <td class="small mono">${esc((e.target ?? "—").slice(0, 20))}</td>
      <td class="wrap small muted">${esc(JSON.stringify(e.meta).slice(0, 160))}</td></tr>`,
  );
  page("Audit log", panel("Recent admin activity", table(
    ["When", "Who", "Action", "Target", "Details"],
    rows,
  )));
}

// ── Actions ──────────────────────────────────────────────

async function doSuspend(req: IncomingMessage, res: ServerResponse, me: Staff): Promise<void> {
  const f = await body(req);
  const siteId = f["siteId"] ?? "";
  const reason = (f["reason"] ?? "").trim() || null;
  const r = await suspendSite(siteId, reason);
  await audit(me.email, "site.suspend", siteId, { reason, ok: r.ok });
  redirect(
    res,
    r.ok
      ? back(`${A}/sites`, "ok", "Site suspended — it is now offline.")
      : back(`${A}/sites`, "err", `Marked suspended, but takedown failed: ${r.error}`),
  );
}

async function doRestore(req: IncomingMessage, res: ServerResponse, me: Staff): Promise<void> {
  const f = await body(req);
  const siteId = f["siteId"] ?? "";
  const r = await restoreSite(siteId);
  await audit(me.email, "site.restore", siteId, { ok: r.ok });
  redirect(
    res,
    r.ok
      ? back(`${A}/sites`, "ok", "Site restored and back online.")
      : back(`${A}/sites`, "err", `Restore failed: ${r.error}`),
  );
}

async function doCredits(req: IncomingMessage, res: ServerResponse, me: Staff): Promise<void> {
  const f = await body(req);
  const userId = f["userId"] ?? "";
  const amount = Number(f["amount"] ?? 0);
  if (!userId || !Number.isInteger(amount) || amount <= 0) {
    redirect(res, back(`${A}/customers`, "err", "Enter a whole number of credits."));
    return;
  }
  const balance = await grant(userId, amount, `admin grant by ${me.email}`, { resetRef: true });
  await audit(me.email, "customer.credits", userId, { amount, balance });
  redirect(res, back(`${A}/customers`, "ok", `Granted ${amount} credits (new balance ${balance}).`));
}

async function doLimit(req: IncomingMessage, res: ServerResponse, me: Staff): Promise<void> {
  const f = await body(req);
  const userId = f["userId"] ?? "";
  const raw = (f["limit"] ?? "").trim().toLowerCase();
  let value: number | null;
  if (raw === "unlimited") value = -1;
  else if (raw === "" || raw === "default") value = null;
  else if (/^\d+$/.test(raw)) value = Number(raw);
  else {
    redirect(res, back(`${A}/customers`, "err", "Use a number, 'unlimited' or 'default'."));
    return;
  }
  await setUserLimit(userId, value);
  await audit(me.email, "customer.limit", userId, { value });
  redirect(res, back(`${A}/customers`, "ok", "Site limit updated."));
}

async function doSettings(req: IncomingMessage, res: ServerResponse, me: Staff): Promise<void> {
  const f = await body(req);
  const key = f["key"] ?? "";
  const value = Number(f["value"] ?? NaN);
  if (!isSettingKey(key) || !Number.isFinite(value) || value < 0) {
    redirect(res, back(`${A}/settings`, "err", "Invalid setting or value."));
    return;
  }
  const before = getNum(key);
  await setNum(key, Math.round(value));
  await audit(me.email, "settings.edit", key, { before, after: Math.round(value) });
  redirect(res, back(`${A}/settings`, "ok", `${labelOf(key)} updated.`));
}

async function doStaffCreate(req: IncomingMessage, res: ServerResponse, me: Staff): Promise<void> {
  const f = await body(req);
  const role = f["role"] ?? "spectator";
  const password = f["password"] ?? "";
  if (!isRole(role) || password.length < 10) {
    redirect(res, back(`${A}/staff`, "err", "Pick a valid role and a 10+ character password."));
    return;
  }
  const staff = await createStaff({
    email: f["email"] ?? "",
    name: f["name"] ?? null,
    password,
    role,
  });
  if (!staff) {
    redirect(res, back(`${A}/staff`, "err", "That email is already registered."));
    return;
  }
  await audit(me.email, "staff.create", staff.id, { email: staff.email, role });
  redirect(res, back(`${A}/staff`, "ok", `${staff.email} added as ${role}.`));
}

async function doStaffRole(req: IncomingMessage, res: ServerResponse, me: Staff): Promise<void> {
  const f = await body(req);
  const id = f["id"] ?? "";
  const role = f["role"] ?? "";
  if (!isRole(role) || id === me.id) {
    redirect(res, back(`${A}/staff`, "err", "Invalid role change."));
    return;
  }
  // Never leave the business without an owner.
  const target = (await listStaff()).find((s) => s.id === id);
  if (target?.role === "owner" && role !== "owner" && (await activeOwnerCount()) <= 1) {
    redirect(res, back(`${A}/staff`, "err", "You can't remove the last owner."));
    return;
  }
  await setStaffRole(id, role);
  await audit(me.email, "staff.role", id, { role });
  redirect(res, back(`${A}/staff`, "ok", "Role updated."));
}

async function doStaffActive(req: IncomingMessage, res: ServerResponse, me: Staff): Promise<void> {
  const f = await body(req);
  const id = f["id"] ?? "";
  const active = f["active"] === "1";
  if (id === me.id) {
    redirect(res, back(`${A}/staff`, "err", "You can't disable your own account."));
    return;
  }
  const target = (await listStaff()).find((s) => s.id === id);
  if (!active && target?.role === "owner" && (await activeOwnerCount()) <= 1) {
    redirect(res, back(`${A}/staff`, "err", "You can't disable the last owner."));
    return;
  }
  await setStaffActive(id, active);
  await audit(me.email, active ? "staff.enable" : "staff.disable", id, {});
  redirect(res, back(`${A}/staff`, "ok", active ? "Account enabled." : "Account disabled."));
}

async function doStaffPassword(req: IncomingMessage, res: ServerResponse, me: Staff): Promise<void> {
  const f = await body(req);
  const id = f["id"] ?? "";
  const password = f["password"] ?? "";
  if (password.length < 10) {
    redirect(res, back(`${A}/staff`, "err", "Password must be at least 10 characters."));
    return;
  }
  await setStaffPassword(id, password);
  await audit(me.email, "staff.password", id, {});
  redirect(res, back(`${A}/staff`, "ok", "Password reset."));
}

/** Boot housekeeping. */
export async function initAdmin(): Promise<void> {
  await purgeExpiredSessions();
  log.info(guardSummary(), "admin control centre");
  if (!guardSummary()["hidden"] && process.env["NODE_ENV"] === "production") {
    log.warn(
      "ADMIN_PATH is still the default /admin — set a secret path in .env so scanners can't find the panel",
    );
  }
  const n = await staffCount();
  if (n === 0) log.warn({ path: A }, "no staff accounts yet — open the admin path to create the owner account");
}
