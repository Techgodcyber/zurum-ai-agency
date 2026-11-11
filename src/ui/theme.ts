/**
 * Shared, world-class design system for Zurum's server-rendered surfaces (admin
 * control centre + customer dashboard). No build step, no CDN, no framework —
 * one self-contained stylesheet + inline SVG icons, so it loads instantly on a
 * bare VPS and passes a strict CSP. Light + dark aware.
 *
 * It styles the SAME class hooks the admin already uses (.card/.panel/table/.tag/
 * .flash/…) so existing pages just get prettier, plus a refined sidebar/topbar
 * shell and components the customer dashboard reuses.
 */

/** Dark-theme CSS variables, reused for the explicit toggle + the OS default. */
const DARK_VARS = `
  --bg:#080b12;--bg2:#0b0f18;--surface:#11151f;--elev:#141a26;
  --line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.05);
  --text:#e8edf5;--text2:#c2cbd9;--muted:#8b98ad;--faint:#5f6b7f;
  --accent:#6366f1;--accent2:#8b5cf6;--accent-weak:rgba(99,102,241,.16);
  --good:#34d399;--good-bg:rgba(52,211,153,.14);
  --warn:#fbbf24;--warn-bg:rgba(251,191,36,.14);
  --bad:#f87171;--bad-bg:rgba(248,113,113,.14);
  --info:#38bdf8;--info-bg:rgba(56,189,248,.14);
  --shadow:0 1px 2px rgba(0,0,0,.3),0 1px 3px rgba(0,0,0,.4);
  --shadow-lg:0 12px 32px -8px rgba(0,0,0,.6),0 2px 8px rgba(0,0,0,.4);
`;

export const UI_CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#f6f7fb;--bg2:#eef1f7;--surface:#ffffff;--elev:#ffffff;
  --line:rgba(16,24,40,.09);--line2:rgba(16,24,40,.06);
  --text:#0f1728;--text2:#344054;--muted:#667085;--faint:#98a2b3;
  --accent:#4f46e5;--accent2:#7c3aed;--accent-weak:rgba(79,70,229,.10);
  --good:#16a34a;--good-bg:rgba(22,163,74,.12);
  --warn:#d97706;--warn-bg:rgba(217,119,6,.12);
  --bad:#dc2626;--bad-bg:rgba(220,38,38,.12);
  --info:#0ea5e9;--info-bg:rgba(14,165,233,.12);
  --shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06);
  --shadow-lg:0 8px 24px -6px rgba(16,24,40,.16),0 2px 6px rgba(16,24,40,.06);
  --radius:16px;--radius-sm:10px;
}
/* Dark palette — applied when the user EXPLICITLY chose dark (data-theme),
   and by default when the OS is dark UNLESS the user forced light. */
:root[data-theme="dark"]{${DARK_VARS}}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK_VARS}}}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);
  font:14.5px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:none;opacity:.85}
::selection{background:var(--accent-weak)}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:20px;border:3px solid transparent;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:var(--faint)}

/* Layout */
.app{display:flex;min-height:100vh}
.side{width:250px;flex:0 0 250px;background:var(--surface);border-right:1px solid var(--line);
  position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:18px 14px}
.side-brand{display:flex;align-items:center;gap:10px;padding:6px 8px 18px;font-weight:750;font-size:18px;letter-spacing:-.02em}
.logo{width:30px;height:30px;border-radius:9px;flex:0 0 30px;display:grid;place-items:center;color:#fff;
  background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 4px 12px -2px var(--accent-weak);font-weight:800}
.side-brand small{font-weight:500;color:var(--muted);font-size:12px;letter-spacing:0}
.nav{display:flex;flex-direction:column;gap:2px;overflow:auto;flex:1}
.nav-label{font-size:11px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);padding:14px 10px 6px}
.nav-item{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:10px;color:var(--text2);
  font-size:14px;font-weight:500;transition:background .14s,color .14s}
.nav-item svg{width:18px;height:18px;flex:0 0 18px;opacity:.75}
.nav-item:hover{background:var(--bg2);color:var(--text);opacity:1}
.nav-item.on{background:var(--accent-weak);color:var(--accent);font-weight:600}
.nav-item.on svg{opacity:1}
.side-foot{border-top:1px solid var(--line);padding-top:12px;margin-top:8px}

.main{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:16px 26px;border-bottom:1px solid var(--line);
  background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(1.4) blur(10px)}
.topbar h1{font-size:19px;font-weight:700;margin:0;letter-spacing:-.02em}
.crumb{font-size:12.5px;color:var(--muted);margin-top:1px}
.content{padding:26px;max-width:1360px;width:100%}
.who{display:flex;align-items:center;gap:12px}
.chip{display:flex;align-items:center;gap:9px;padding:5px 6px 5px 12px;border:1px solid var(--line);border-radius:999px;background:var(--surface)}
.chip .avatar{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));
  color:#fff;display:grid;place-items:center;font-size:12px;font-weight:700}
.chip .who-name{font-size:13px;font-weight:600;line-height:1.1}
.chip .who-sub{font-size:11px;color:var(--muted)}

h1{font-size:22px;letter-spacing:-.02em}
h2,.section{font-size:12px;margin:26px 0 12px;color:var(--muted);font-weight:650;text-transform:uppercase;letter-spacing:.05em}
.muted{color:var(--muted)}.small{font-size:12.5px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.spread{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}

/* Stat cards */
.cards,.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 18px;box-shadow:var(--shadow)}
.card .k{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600;display:flex;align-items:center;gap:7px}
.card .k svg{width:15px;height:15px;opacity:.7}
.card .v{font-size:27px;font-weight:730;margin-top:9px;letter-spacing:-.02em}
.card .s{font-size:12.5px;color:var(--muted);margin-top:3px}

/* Panels + tables */
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin-bottom:18px;box-shadow:var(--shadow)}
.panel .hd{padding:15px 18px;border-bottom:1px solid var(--line);font-weight:650;font-size:14.5px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.panel .hd .sub{font-weight:400;color:var(--muted);font-size:12.5px}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:13px 18px;border-bottom:1px solid var(--line2);vertical-align:middle;white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;background:var(--bg2)}
tbody tr,tr{transition:background .12s}
tbody tr:hover td{background:var(--bg2)}
tr:last-child td{border-bottom:none}
td.wrap,th.wrap{white-space:normal;min-width:15rem}

/* Pills / badges */
.tag,.pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:11.5px;font-weight:600;border:1px solid transparent;line-height:1.4}
.tag.ok,.pill.ok{color:var(--good);background:var(--good-bg)}
.tag.warn,.pill.warn{color:var(--warn);background:var(--warn-bg)}
.tag.bad,.pill.bad{color:var(--bad);background:var(--bad-bg)}
.tag.info,.pill.info{color:var(--info);background:var(--info-bg)}
.tag.mute,.pill.mute{color:var(--muted);background:var(--bg2);border-color:var(--line)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}

/* Forms */
input,select,textarea{background:var(--surface);border:1px solid var(--line);color:var(--text);border-radius:var(--radius-sm);
  padding:9px 12px;font:inherit;font-size:14px;transition:border-color .14s,box-shadow .14s;width:auto}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak)}
input::placeholder{color:var(--faint)}
label{display:block;font-size:12.5px;color:var(--text2);font-weight:600;margin:0 0 6px}

/* Buttons */
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:var(--accent);color:#fff;border:0;
  border-radius:var(--radius-sm);padding:9px 15px;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;
  transition:transform .12s,filter .14s,box-shadow .14s;box-shadow:0 1px 2px rgba(16,24,40,.12)}
button:hover,.btn:hover{filter:brightness(1.06);transform:translateY(-1px)}
button:active,.btn:active{transform:translateY(0)}
button svg,.btn svg{width:16px;height:16px}
button.ghost,.btn.ghost{background:var(--surface);border:1px solid var(--line);color:var(--text);box-shadow:none}
button.ghost:hover,.btn.ghost:hover{background:var(--bg2);filter:none}
button.danger,.btn.danger{background:var(--bad)}
button.good,.btn.good{background:var(--good)}
button.sm,.btn.sm,button.small{padding:7px 11px;font-size:12.5px}
.btn-lg{padding:12px 20px;font-size:15px;border-radius:12px}
form.inline{display:inline-flex;gap:8px;align-items:center;margin:0}
/* Theme toggle: show the moon in light mode (tap → dark), sun in dark mode. */
.theme-btn{padding:8px}.theme-btn span{display:inline-flex;align-items:center}
.theme-btn .sun{display:none}
:root[data-theme="dark"] .theme-btn .sun{display:inline-flex}
:root[data-theme="dark"] .theme-btn .moon{display:none}
@media(prefers-color-scheme:dark){
  :root:not([data-theme="light"]) .theme-btn .sun{display:inline-flex}
  :root:not([data-theme="light"]) .theme-btn .moon{display:none}
}

/* Alerts */
.flash{padding:13px 16px;border-radius:12px;margin-bottom:18px;border:1px solid;font-size:13.5px;display:flex;gap:10px;align-items:center}
.flash.ok{background:var(--good-bg);border-color:transparent;color:var(--good)}
.flash.err{background:var(--bad-bg);border-color:transparent;color:var(--bad)}

/* Empty state */
.empty{text-align:center;padding:46px 20px;color:var(--muted)}
.empty svg{width:38px;height:38px;opacity:.5;margin-bottom:10px}

/* Auth pages */
.auth{min-height:100vh;display:grid;place-items:center;padding:24px;
  background:radial-gradient(1200px 600px at 50% -10%,var(--accent-weak),transparent 70%),var(--bg)}
.auth-card{width:100%;max-width:400px;background:var(--surface);border:1px solid var(--line);border-radius:20px;
  padding:32px;box-shadow:var(--shadow-lg)}
.auth-card .logo{width:44px;height:44px;border-radius:13px;font-size:20px;margin-bottom:18px}
.auth-card h1{font-size:21px;margin:0 0 4px;letter-spacing:-.02em}
.auth-card p.sub{margin:0 0 22px;color:var(--muted);font-size:13.5px}
.auth-card label{margin-top:14px}
.auth-card input{width:100%}
.auth-card button[type=submit],.auth-card .btn-lg{width:100%;margin-top:20px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.caps{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.caps span{font-size:11px;padding:2px 7px;border:1px solid var(--line);border-radius:6px;color:var(--muted)}

@media(max-width:860px){
  .app{flex-direction:column}
  .side{width:100%;flex:none;height:auto;position:static;flex-direction:row;align-items:center;gap:6px;
    border-right:0;border-bottom:1px solid var(--line);padding:10px 12px;overflow-x:auto}
  .side-brand{padding:0 8px 0 0;white-space:nowrap}.side-brand small{display:none}
  .nav{flex-direction:row;gap:4px}.nav-label,.side-foot{display:none}
  .nav-item{white-space:nowrap;padding:8px 11px}.nav-item span{display:none}
  .topbar{padding:14px 16px}.content{padding:16px}
}
`;

/** Inline line-icon set (24×24, stroke = currentColor). Crisp, not emoji. */
const ICONS: Record<string, string> = {
  grid: `<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>`,
  globe: `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/>`,
  users: `<path d="M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1"/><circle cx="9.5" cy="8" r="3.2"/><path d="M21 20v-1a4 4 0 0 0-3-3.8"/><path d="M16.5 4.9a3.2 3.2 0 0 1 0 6.2"/>`,
  inbox: `<path d="M3 12h5l2 3h4l2-3h5"/><path d="M4 6.5 3 12v6a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6l-1-5.5A2 2 0 0 0 18 5H6a2 2 0 0 0-2 1.5z"/>`,
  activity: `<path d="M3 12h4l3 8 4-16 3 8h4"/>`,
  wallet: `<path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1H3z"/><path d="M3 8h17a1 1 0 0 1 1 1v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="16.5" cy="13" r="1.3"/>`,
  settings: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 0 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.6-1H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a1.7 1.7 0 0 0 1-1.6V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`,
  shield: `<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  download: `<path d="M12 3v12M7 11l5 5 5-5M5 21h14"/>`,
  lock: `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>`,
  logout: `<path d="M15 12H3M8 7l-5 5 5 5M14 5h5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-5"/>`,
  layers: `<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>`,
  folder: `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`,
  life: `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.4"/><path d="M5 5l4.2 4.2M14.8 14.8 19 19M19 5l-4.2 4.2M9.2 14.8 5 19"/>`,
  user: `<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>`,
  link: `<path d="M9 15l6-6M10.5 6.5l1.8-1.8a4 4 0 0 1 5.7 5.7L16 12.5M7.5 11.5 5.7 13.3a4 4 0 0 0 5.7 5.7l1.8-1.8"/>`,
  spark: `<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5 10.1 12 4.5 10l5.6-1.4z"/>`,
  chat: `<path d="M21 12a8 8 0 0 1-11.7 7.1L4 20l1-4.3A8 8 0 1 1 21 12z"/>`,
  moon: `<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>`,
  sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
};

/** Render an inline SVG icon by name. */
export function icon(name: string, size = 18): string {
  const p = ICONS[name] ?? ICONS.grid!;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

/** A brand logo mark (the gradient square with the first letter). */
export function logoMark(letter = "Z", size = 30): string {
  return `<span class="logo" style="width:${size}px;height:${size}px;flex-basis:${size}px">${letter}</span>`;
}

/** Initials for an avatar chip. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "•";
}

/**
 * Inline head script: applies the SAVED theme before first paint (no flash) and
 * exposes window.zurumToggleTheme(). Belongs in <head>, before the body renders.
 */
export const THEME_INIT = `<script>(function(){try{var d=document.documentElement,t=localStorage.getItem('zurum-theme');if(t==='dark'||t==='light')d.dataset.theme=t;}catch(e){}window.zurumToggleTheme=function(){try{var d=document.documentElement,cur=d.dataset.theme||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'),n=cur==='dark'?'light':'dark';d.dataset.theme=n;localStorage.setItem('zurum-theme',n);}catch(e){}};})();</script>`;

/** The light/dark toggle button (sun in dark mode, moon in light mode). */
export function themeToggle(): string {
  return `<button type="button" class="ghost sm theme-btn" onclick="zurumToggleTheme()" title="Switch light / dark" aria-label="Switch light or dark theme"><span class="moon">${icon(
    "moon",
    16,
  )}</span><span class="sun">${icon("sun", 16)}</span></button>`;
}
