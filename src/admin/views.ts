import { BRAND } from "../config/brand.js";
import { env } from "../config/env.js";
import { ROLE_DESCRIPTION, ROLES, type Capability, type Role } from "./roles.js";
import { capabilitiesFor } from "./roles.js";
import { UI_CSS, icon, logoMark, initials, THEME_INIT, themeToggle } from "../ui/theme.js";

/** The (possibly secret) URL prefix every admin link must be built from. */
export const A = env.ADMIN_PATH;

/**
 * Server-rendered admin UI. No build step, no framework, no CDN — the control
 * centre must always load, even on a fresh VPS with nothing installed.
 */

/** Escape untrusted text for HTML. */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = UI_CSS;

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  cap?: Capability;
}

const NAV: NavItem[] = [
  { href: A, label: "Dashboard", icon: "grid" },
  { href: `${A}/sites`, label: "Sites", icon: "globe", cap: "sites.view" },
  { href: `${A}/customers`, label: "Customers", icon: "users", cap: "customers.view" },
  { href: `${A}/submissions`, label: "Enquiries", icon: "inbox", cap: "submissions.view" },
  { href: `${A}/jobs`, label: "Builds", icon: "activity", cap: "jobs.view" },
  { href: `${A}/revenue`, label: "Revenue", icon: "wallet", cap: "revenue.view" },
  { href: `${A}/security`, label: "Security", icon: "shield", cap: "revenue.view" },
  { href: `${A}/settings`, label: "Settings", icon: "settings", cap: "settings.view" },
  { href: `${A}/staff`, label: "Staff", icon: "shield", cap: "staff.view" },
  { href: `${A}/audit`, label: "Audit log", icon: "clock", cap: "audit.view" },
];

export function layout(o: {
  title: string;
  path: string;
  role: Role;
  email: string;
  body: string;
  flash?: { kind: "ok" | "err"; text: string } | null;
}): string {
  const caps = capabilitiesFor(o.role);
  const nav = NAV.filter((n) => !n.cap || caps.includes(n.cap))
    .map(
      (n) =>
        `<a href="${n.href}" class="nav-item ${o.path === n.href ? "on" : ""}">${icon(n.icon)}<span>${esc(n.label)}</span></a>`,
    )
    .join("");
  const flash = o.flash ? `<div class="flash ${o.flash.kind}">${esc(o.flash.text)}</div>` : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(o.title)} · ${BRAND.name} Admin</title><style>${CSS}</style>${THEME_INIT}</head>
<body><div class="app">
<aside class="side">
  <div class="side-brand">${logoMark(BRAND.name[0] ?? "Z")}<div>${BRAND.name}<br><small>Control centre</small></div></div>
  <nav class="nav"><div class="nav-label">Overview</div>${nav}</nav>
</aside>
<div class="main">
  <header class="topbar">
    <div><h1>${esc(o.title)}</h1></div>
    <div class="who">
      ${themeToggle()}
      <div class="chip"><span class="avatar">${esc(initials(o.email))}</span>
        <span><span class="who-name">${esc(o.email)}</span><br><span class="who-sub">${esc(o.role)}</span></span></div>
      <form method="POST" action="${A}/logout" class="inline">
        <button class="ghost sm" title="Sign out">${icon("logout", 16)}</button></form>
    </div>
  </header>
  <div class="content">${flash}${o.body}</div>
</div></div></body></html>`;
}

function authShell(title: string, inner: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · ${BRAND.name} Admin</title><style>${CSS}</style>${THEME_INIT}</head>
<body><div class="auth"><div style="position:fixed;top:16px;right:16px">${themeToggle()}</div>
<div class="auth-card">${logoMark(BRAND.name[0] ?? "Z", 44)}${inner}</div></div></body></html>`;
}

export function loginPage(error?: string, notice?: string): string {
  return authShell(
    "Sign in",
    `<h1>${BRAND.name} Admin</h1><p class="sub">Sign in to the control centre.</p>
${error ? `<div class="flash err">${esc(error)}</div>` : ""}
${notice ? `<div class="flash ok">${esc(notice)}</div>` : ""}
<form method="POST" action="${A}/login">
<label for="e">Email</label><input id="e" name="email" type="email" required autofocus autocomplete="username">
<label for="p">Password</label><input id="p" name="password" type="password" required autocomplete="current-password">
<button type="submit" class="btn-lg">Sign in</button></form>`,
  );
}

export function setupPage(error?: string): string {
  return authShell(
    "Set up",
    `<h1>Welcome to ${BRAND.name}</h1><p class="sub">Create the owner account for your control centre. This runs once.</p>
${error ? `<div class="flash err">${esc(error)}</div>` : ""}
<form method="POST" action="${A}/setup">
<label for="n">Your name</label><input id="n" name="name" required autofocus>
<label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="username">
<label for="p">Password (min 10 characters)</label><input id="p" name="password" type="password" minlength="10" required autocomplete="new-password">
<button type="submit" class="btn-lg">Create owner account</button></form>`,
  );
}

// ── Small render helpers ─────────────────────────────────

export function card(k: string, v: string | number, s = ""): string {
  return `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${
    s ? `<div class="s">${esc(s)}</div>` : ""
  }</div>`;
}

export function table(headers: string[], rows: string[]): string {
  if (!rows.length) {
    return `<div class="tablewrap"><table><thead><tr>${headers
      .map((h) => `<th>${esc(h)}</th>`)
      .join("")}</tr></thead><tbody><tr><td colspan="${headers.length}" class="muted">Nothing here yet.</td></tr></tbody></table></div>`;
  }
  return `<div class="tablewrap"><table><thead><tr>${headers
    .map((h) => `<th>${esc(h)}</th>`)
    .join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

export function panel(title: string, body: string, actions = ""): string {
  return `<div class="panel"><div class="hd"><span>${esc(title)}</span>${actions}</div>${body}</div>`;
}

export function when(dt: string): string {
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export function roleOptions(current: Role): string {
  return ROLES.map(
    (r) =>
      `<option value="${r}"${r === current ? " selected" : ""}>${r} — ${esc(
        ROLE_DESCRIPTION[r],
      )}</option>`,
  ).join("");
}
