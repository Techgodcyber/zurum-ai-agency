/**
 * HTML for the customer-site backend's transactional emails and the hosted
 * password-reset page. Kept self-contained (inline styles) and free of any
 * external resources.
 */

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

/** The "reset your password" email sent to a site's end-user. */
export function resetEmail(link: string, siteName: string): { subject: string; html: string } {
  const site = esc(siteName);
  return {
    subject: `Reset your password`,
    html: `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
  <h1 style="font-size:20px;margin:0 0 12px">Reset your password</h1>
  <p style="margin:0 0 16px;line-height:1.6;color:#334155">We received a request to reset your password for <strong>${site}</strong>. Click the button below to choose a new one. This link expires in 30 minutes.</p>
  <p style="margin:0 0 24px"><a href="${esc(link)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Reset password</a></p>
  <p style="margin:0 0 8px;font-size:13px;color:#64748b">If the button doesn't work, paste this link into your browser:</p>
  <p style="margin:0 0 24px;font-size:13px;word-break:break-all"><a href="${esc(link)}" style="color:#4f46e5">${esc(link)}</a></p>
  <p style="margin:0;font-size:13px;color:#94a3b8">If you didn't request this, you can safely ignore this email — your password won't change.</p>
</div>`,
  };
}

/** The "confirm your email" email sent to a site's end-user on signup. */
export function verifyEmailTemplate(link: string, siteName: string): { subject: string; html: string } {
  const site = esc(siteName);
  return {
    subject: `Confirm your email`,
    html: `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
  <h1 style="font-size:20px;margin:0 0 12px">Confirm your email</h1>
  <p style="margin:0 0 16px;line-height:1.6;color:#334155">Thanks for signing up on <strong>${site}</strong>! Tap the button below to confirm this email address.</p>
  <p style="margin:0 0 24px"><a href="${esc(link)}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Confirm email</a></p>
  <p style="margin:0 0 8px;font-size:13px;color:#64748b">If the button doesn't work, paste this link into your browser:</p>
  <p style="margin:0 0 24px;font-size:13px;word-break:break-all"><a href="${esc(link)}" style="color:#16a34a">${esc(link)}</a></p>
  <p style="margin:0;font-size:13px;color:#94a3b8">If you didn't create this account, you can ignore this email.</p>
</div>`,
  };
}

/** The page shown after clicking a verification link (success or expired). */
export function verifiedPageHtml(ok: boolean): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Email ${ok ? "confirmed" : "link"}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f1f5f9;color:#0f172a}
@media(prefers-color-scheme:dark){body{background:#0b1220;color:#e2e8f0}.card{background:#111827 !important;border-color:#1f2937 !important}}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:32px;width:min(92vw,380px);text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.08)}
.i{font-size:44px;line-height:1;margin-bottom:10px}h1{font-size:20px;margin:0 0 6px}p{margin:0;color:#64748b;font-size:14px}
</style></head><body><div class="card">
${ok
    ? `<div class="i">✅</div><h1>Email confirmed</h1><p>Thanks — your email address is verified. You can close this tab and continue.</p>`
    : `<div class="i">⚠️</div><h1>Link invalid or expired</h1><p>This confirmation link is no longer valid. Please sign in and request a new one.</p>`}
</div></body></html>`;
}

/**
 * The hosted page a reset link opens: a minimal, self-contained new-password form
 * that POSTs JSON back to the reset endpoint and shows the result inline.
 */
export function resetPageHtml(siteId: string, token: string): string {
  const postUrl = `/api/${encodeURIComponent(siteId)}/auth/reset`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset your password</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f1f5f9;color:#0f172a}
@media(prefers-color-scheme:dark){body{background:#0b1220;color:#e2e8f0}.card{background:#111827 !important;border-color:#1f2937 !important}}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;width:min(92vw,400px);box-shadow:0 10px 30px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 6px}p.sub{margin:0 0 18px;color:#64748b;font-size:14px}
label{display:block;font-size:13px;font-weight:600;margin:0 0 6px}
input{width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:15px;background:transparent;color:inherit}
button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:9px;background:#4f46e5;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.msg{margin-top:14px;font-size:14px;min-height:20px}
.ok{color:#16a34a}.err{color:#dc2626}
</style></head><body>
<div class="card">
  <h1>Choose a new password</h1>
  <p class="sub">Enter a new password for your account.</p>
  <form id="f">
    <label for="pw">New password</label>
    <input id="pw" type="password" autocomplete="new-password" minlength="8" required placeholder="At least 8 characters">
    <button type="submit">Reset password</button>
    <div class="msg" id="m"></div>
  </form>
</div>
<script>
(function(){
  var token = ${JSON.stringify(token)};
  var f = document.getElementById("f"), pw = document.getElementById("pw"), m = document.getElementById("m"), b = f.querySelector("button");
  f.addEventListener("submit", function(ev){
    ev.preventDefault(); m.textContent=""; m.className="msg";
    if(pw.value.length < 8){ m.textContent="Password must be at least 8 characters."; m.className="msg err"; return; }
    b.disabled=true;
    fetch(${JSON.stringify(postUrl)}, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:token,password:pw.value})})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {ok:r.ok,j:j};});})
      .then(function(res){
        if(res.ok){ m.textContent="✓ Your password has been reset. You can now log in."; m.className="msg ok"; f.querySelector("input").disabled=true; b.style.display="none"; }
        else { m.textContent = res.j.error==="invalid_token" ? "This reset link is invalid or has expired. Please request a new one." : (res.j.error==="weak_password" ? "Password must be 8–200 characters." : "Something went wrong. Please try again."); m.className="msg err"; b.disabled=false; }
      })
      .catch(function(){ m.textContent="Network error. Please try again."; m.className="msg err"; b.disabled=false; });
  });
})();
</script>
</body></html>`;
}
