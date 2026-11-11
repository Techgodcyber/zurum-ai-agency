/**
 * The Zurum front-end auth SDK — a tiny (~2KB) vanilla-JS drop-in that generated
 * sites include to make their login/register forms and dashboards actually work
 * against the customer-site backend (§14).
 *
 * Served CENTRALLY from `GET /api/zurum-auth.js`, so a fix ships to every site at
 * once (the central-patching strategy — §14.5). A site includes it with:
 *
 *   <script src="https://app.zurum.co/api/zurum-auth.js" data-zurum-site="SITE_ID"></script>
 *
 * Then it auto-wires by data-attribute (no coding needed in the generated HTML):
 *   <form data-zurum="register" data-zurum-redirect="/dashboard"> … name/email/password inputs …
 *   <form data-zurum="login"    data-zurum-redirect="/dashboard"> … email/password …
 *   <button data-zurum="logout" data-zurum-redirect="/">Log out</button>
 *   <span data-zurum-user></span>              → filled with the user's name/email
 *   <div data-zurum-auth>…</div>               → shown only when logged in
 *   <div data-zurum-guest>…</div>              → shown only when logged out
 *   <p data-zurum-message></p>                 → inline error target inside a form
 * And a JS API: window.Zurum.register/login/logout/me/save/list/remove.
 */
export const ZURUM_SDK_JS = `(function () {
  var script = document.currentScript;
  // Base API origin: an explicit global wins (set when the SDK is INLINED into a
  // site hosted on another domain), else the script's own origin, else here.
  var base = window.ZURUM_BASE || (script && script.src ? new URL(script.src).origin : location.origin);
  var site = window.ZURUM_SITE || (script && script.getAttribute("data-zurum-site")) ||
    ((document.querySelector('meta[name="zurum-site"]') || {}).content);
  if (!site) { console.error("[Zurum] no site id — add data-zurum-site to the script tag"); return; }
  var KEY = "zurum_token_" + site;
  function tok() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function setTok(t) { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch (e) {} }
  function api(path, opts) {
    opts = opts || {};
    var headers = { "content-type": "application/json" };
    var t = tok(); if (t) headers["authorization"] = "Bearer " + t;
    return fetch(base + "/api/" + encodeURIComponent(site) + path, {
      method: opts.method || "GET", headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error((j && j.error) || ("http_" + r.status)); e.data = j; e.status = r.status; throw e; }
        return j;
      });
    });
  }
  var Z = {
    site: site,
    get token() { return tok(); },
    isLoggedIn: function () { return !!tok(); },
    register: function (email, password, name) {
      return api("/auth/register", { method: "POST", body: { email: email, password: password, name: name } })
        .then(function (r) { setTok(r.token); return r.user; });
    },
    login: function (email, password) {
      return api("/auth/login", { method: "POST", body: { email: email, password: password } })
        .then(function (r) { setTok(r.token); return r.user; });
    },
    logout: function () { return api("/auth/logout", { method: "POST" }).then(function () { setTok(null); }); },
    me: function () { return api("/auth/me").then(function (r) { return r.user; }); },
    requestReset: function (email) { return api("/auth/request-reset", { method: "POST", body: { email: email } }); },
    resendVerification: function () { return api("/auth/resend-verification", { method: "POST" }); },
    save: function (collection, data, opts) {
      return api("/data/" + encodeURIComponent(collection), { method: "POST", body: { data: data, shared: !!(opts && opts.shared) } })
        .then(function (r) { return r.record; });
    },
    list: function (collection, opts) {
      var q = "";
      if (opts && (opts.limit != null || opts.offset != null)) {
        q = "?limit=" + (opts.limit || 100) + "&offset=" + (opts.offset || 0);
      }
      return api("/data/" + encodeURIComponent(collection) + q).then(function (r) { return r.records; });
    },
    update: function (collection, id, data) {
      return api("/data/" + encodeURIComponent(collection) + "/" + encodeURIComponent(id), { method: "PATCH", body: { data: data } })
        .then(function (r) { return r.record; });
    },
    remove: function (collection, id) { return api("/data/" + encodeURIComponent(collection) + "/" + encodeURIComponent(id), { method: "DELETE" }); },
    // STORE: list products, buy one, or check out a cart. Buyers pay on the
    // merchant's Flutterwave page (money goes to the merchant).
    products: function () { return api("/products").then(function (r) { return r; }); },
    checkout: function (cart, buyer) {
      return api("/checkout", { method: "POST", body: { items: cart, buyer: buyer || {} } })
        .then(function (r) { if (r.url) { location.href = r.url; } return r; });
    },
    buy: function (productId, buyer) { return this.checkout([{ productId: productId, qty: 1 }], buyer); },
    // Upload an image File/Blob; resolves to {id, url, mime, size}. Use url in <img src>.
    upload: function (file) {
      var headers = {}; var t = tok(); if (t) headers["authorization"] = "Bearer " + t;
      return fetch(base + "/api/" + encodeURIComponent(site) + "/upload", { method: "POST", headers: headers, body: file })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error((j && j.error) || ("http_" + r.status)); e.data = j; throw e; } return j; }); });
    }
  };
  function esc(s) { var d = document.createElement("div"); d.textContent = String(s == null ? "" : s); return d.innerHTML; }
  function friendly(e) {
    var m = { invalid_credentials: "Wrong email or password.", email_taken: "That email is already registered.",
      weak_password: "Password must be at least 8 characters.", invalid_email: "Please enter a valid email address.",
      rate_limited: "Too many attempts — please wait a minute and try again.",
      // Backend not yet activated — this is a free preview; accounts turn on once
      // the site is published (publish-to-pay).
      not_found: "Accounts activate once this site is published." };
    var code = (e && e.data && e.data.error) || (e && e.message);
    return m[code] || (code === "http_404" ? m.not_found : "Something went wrong. Please try again.");
  }
  function wire() {
    document.querySelectorAll('form[data-zurum]').forEach(function (f) {
      var mode = f.getAttribute("data-zurum");
      if (mode !== "register" && mode !== "login") return;
      f.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var fd = new FormData(f), msg = f.querySelector("[data-zurum-message]");
        var email = fd.get("email"), password = fd.get("password"), name = fd.get("name");
        if (msg) msg.textContent = "";
        var p = mode === "register" ? Z.register(email, password, name) : Z.login(email, password);
        p.then(function () { var r = f.getAttribute("data-zurum-redirect"); if (r) location.href = r; else location.reload(); })
         .catch(function (e) { var t = friendly(e); if (msg) msg.textContent = t; else alert(t); });
      });
    });
    document.querySelectorAll('form[data-zurum="reset-request"]').forEach(function (f) {
      f.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var fd = new FormData(f), msg = f.querySelector("[data-zurum-message]");
        Z.requestReset(fd.get("email")).then(function () {
          var t = "If that email is registered, we've sent a reset link. Check your inbox.";
          if (msg) { msg.textContent = t; } else { alert(t); }
        }).catch(function () { if (msg) msg.textContent = "Please try again in a moment."; });
      });
    });
    document.querySelectorAll('[data-zurum="logout"]').forEach(function (b) {
      b.addEventListener("click", function (ev) { ev.preventDefault(); Z.logout().then(function () { location.href = b.getAttribute("data-zurum-redirect") || "/"; }); });
    });
    document.querySelectorAll('[data-zurum="resend-verification"]').forEach(function (b) {
      b.addEventListener("click", function (ev) {
        ev.preventDefault();
        Z.resendVerification().then(function () {
          var t = "We've re-sent the confirmation email — please check your inbox.";
          var m = document.querySelector("[data-zurum-message]"); if (m) { m.textContent = t; } else { alert(t); }
        }).catch(function () {});
      });
    });
    var authed = Z.isLoggedIn();
    document.querySelectorAll("[data-zurum-auth]").forEach(function (el) { el.style.display = authed ? "" : "none"; });
    document.querySelectorAll("[data-zurum-guest]").forEach(function (el) { el.style.display = authed ? "none" : ""; });
    if (authed) {
      Z.me().then(function (u) {
        if (!u) { setTok(null); return; }
        document.querySelectorAll("[data-zurum-user]").forEach(function (el) { el.textContent = u.name || u.email; });
        // Show any "please confirm your email" prompt only when NOT yet verified.
        document.querySelectorAll("[data-zurum-unverified]").forEach(function (el) { el.style.display = u.emailVerified ? "none" : ""; });
      }).catch(function () { /* stale token — leave gates as-is */ });
    }

    // STORE: auto-fill <div data-zurum-products> with product cards + Buy buttons.
    var grids = document.querySelectorAll("[data-zurum-products]");
    if (grids.length) {
      Z.products().then(function (r) {
        var items = (r && r.products) || [], cur = (r && r.currency) || "";
        grids.forEach(function (g) {
          if (!items.length) { g.innerHTML = '<p style="opacity:.6">No products yet — check back soon.</p>'; return; }
          var wrap = document.createElement("div");
          wrap.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px";
          items.forEach(function (p) {
            var card = document.createElement("div");
            card.style.cssText = "border:1px solid rgba(0,0,0,.12);border-radius:12px;overflow:hidden;display:flex;flex-direction:column";
            card.innerHTML =
              (p.imageUrl ? '<img src="' + esc(p.imageUrl) + '" alt="" style="width:100%;height:160px;object-fit:cover">' : "") +
              '<div style="padding:12px;flex:1"><div style="font-weight:600">' + esc(p.name) +
              '</div><div style="margin-top:4px;opacity:.75">' + esc(cur) + " " + Number(p.price).toLocaleString() + "</div></div>";
            var btn = document.createElement("button");
            btn.textContent = "Buy now";
            btn.style.cssText = "margin:0 12px 12px;padding:9px 14px;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer";
            btn.onclick = function () { btn.disabled = true; btn.textContent = "…"; Z.buy(p.id).catch(function () { btn.disabled = false; btn.textContent = "Buy now"; alert("Couldn't start checkout — please try again."); }); };
            card.appendChild(btn); wrap.appendChild(card);
          });
          g.innerHTML = ""; g.appendChild(wrap);
        });
      }).catch(function () {});
    }
    // Explicit Buy buttons anywhere: <button data-zurum-buy="PRODUCT_ID">
    document.querySelectorAll("[data-zurum-buy]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.preventDefault(); b.disabled = true; Z.buy(b.getAttribute("data-zurum-buy")).catch(function () { b.disabled = false; alert("Couldn't start checkout — please try again."); }); });
    });
  }
  if (document.readyState !== "loading") wire(); else document.addEventListener("DOMContentLoaded", wire);
  window.Zurum = Z;
})();`;

/**
 * The runtime block INLINED into a generated dynamic site: it pins the API base
 * + this site's id, then embeds the SDK, so the site is fully self-contained
 * (no external script) yet talks to the Zurum backend. Escapes any `</script>`
 * in the payload so it can't break out of the tag.
 */
export function backendBootScript(siteId: string, apiBase: string): string {
  const boot =
    `window.ZURUM_BASE=${JSON.stringify(apiBase)};` +
    `window.ZURUM_SITE=${JSON.stringify(siteId)};\n${ZURUM_SDK_JS}`;
  return `<script>${boot.replace(/<\/script>/gi, "<\\/script>")}</script>`;
}

/** Inject the backend runtime into a document (just before </body>, else append). */
export function injectBackendSdk(html: string, siteId: string, apiBase: string): string {
  const tag = backendBootScript(siteId, apiBase);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}\n</body>`);
  return html + tag;
}

/**
 * A tiny privacy-friendly analytics beacon injected into EVERY published site
 * (static or dynamic). Sends one pageview to /track — a random 1st-party
 * visitor id (localStorage), the path and the referrer host. No PII, no cookies.
 */
export function trackingSnippet(siteId: string, apiBase: string): string {
  const u = `${apiBase}/api/${encodeURIComponent(siteId)}/track`;
  return `<script>(function(){try{var v=localStorage.getItem('zvid');if(!v){v=Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem('zvid',v);}var d=JSON.stringify({path:location.pathname,ref:document.referrer?new URL(document.referrer).hostname:'',vid:v});var u=${JSON.stringify(u)};if(navigator.sendBeacon){navigator.sendBeacon(u,d);}else{fetch(u,{method:'POST',body:d,keepalive:true,mode:'no-cors'});}}catch(e){}})();</script>`;
}

/** Inject the analytics beacon into a page (idempotent). */
export function injectTracker(html: string, siteId: string, apiBase: string): string {
  if (/localStorage\.getItem\('zvid'\)/.test(html)) return html; // already present
  const tag = trackingSnippet(siteId, apiBase);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}\n</body>`);
  return html + tag;
}
