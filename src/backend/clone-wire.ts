/**
 * Best-effort wiring of a CLONED site's login/register forms to the Zurum
 * backend. A cloned page keeps the original's markup, so its login form does
 * nothing on the new domain. This scans each page for a password form and:
 *   - tags it data-zurum="login" | "register",
 *   - normalises the field names the SDK expects (email/password/name),
 *   - drops in a <p data-zurum-message> for inline errors.
 * The injected runtime (window.Zurum) then makes it work.
 *
 * It is intentionally conservative: if a form doesn't clearly have a password
 * field it's left untouched, and odd/custom forms may still need a manual tweak
 * (an honest limitation of auto-wiring someone else's HTML).
 */

/** Add or replace an attribute on a single tag string. */
function setAttr(tag: string, attr: string, value: string): string {
  const re = new RegExp(`\\b${attr}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  if (re.test(tag)) return tag.replace(re, `${attr}="${value}"`);
  // insert right after the tag name
  return tag.replace(/^<([a-zA-Z0-9]+)/, `<$1 ${attr}="${value}"`);
}

function isPassword(tag: string): boolean {
  return /type\s*=\s*["']?password/i.test(tag);
}
function looksEmail(tag: string): boolean {
  return (
    /type\s*=\s*["']?email/i.test(tag) ||
    /(name|id|placeholder|autocomplete)\s*=\s*["'][^"']*e-?mail/i.test(tag)
  );
}
function looksName(tag: string): boolean {
  return (
    /(id|placeholder|autocomplete)\s*=\s*["'][^"']*(full[\s-]?name|your name|^name$|\bname\b)/i.test(tag) &&
    !/e-?mail|pass|user/i.test(tag)
  );
}
function isTextish(tag: string): boolean {
  return !isPassword(tag) && (!/type\s*=/i.test(tag) || /type\s*=\s*["']?(text|email|tel)/i.test(tag));
}

/** Rewrite the inputs inside one form's inner HTML to the names the SDK reads. */
function wireInputs(inner: string, register: boolean): string {
  let assignedEmail = false;
  let assignedName = false;
  // First pass: obvious matches (password, clearly-email, clearly-name).
  let out = inner.replace(/<input\b[^>]*>/gi, (tag) => {
    if (isPassword(tag)) return setAttr(tag, "name", "password");
    if (!assignedEmail && looksEmail(tag)) {
      assignedEmail = true;
      return setAttr(tag, "name", "email");
    }
    if (register && !assignedName && looksName(tag)) {
      assignedName = true;
      return setAttr(tag, "name", "name");
    }
    return tag;
  });
  // Second pass: if no email field was found, map the first remaining text-ish
  // input (that we didn't already claim) to email — most auth forms are email-based.
  if (!assignedEmail) {
    let done = false;
    out = out.replace(/<input\b[^>]*>/gi, (tag) => {
      if (done) return tag;
      if (isPassword(tag)) return tag;
      if (/\bname\s*=\s*["']?(name|email|password)\b/i.test(tag)) return tag; // already ours
      if (isTextish(tag)) {
        done = true;
        return setAttr(tag, "name", "email");
      }
      return tag;
    });
  }
  return out;
}

export interface WireResult {
  html: string;
  hasAuth: boolean;
}

/** Wire any login/register forms in a cloned page. */
export function wireClonedAuth(html: string): WireResult {
  let hasAuth = false;
  try {
    const out = html.replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, (form) => {
      if (!isPassword(form)) return form; // not an auth form
      hasAuth = true;
      // register if it has a 2nd password (confirm) or sign-up wording, else login.
      const passwordCount = (form.match(/type\s*=\s*["']?password/gi) ?? []).length;
      const register =
        passwordCount > 1 ||
        /(register|sign[\s-]?up|create[\s-]?account|create[\s-]?an[\s-]?account|get[\s-]?started)/i.test(form);
      const openMatch = /^<form\b[^>]*>/i.exec(form);
      if (!openMatch) return form;
      const open = openMatch[0];
      const rest = form.slice(open.length); // inner + </form>
      let newOpen = setAttr(open, "data-zurum", register ? "register" : "login");
      // Don't let the original action navigate to the origin — the SDK handles submit.
      newOpen = setAttr(newOpen, "action", "javascript:void(0)");
      const innerWithClose = rest.replace(/<\/form>\s*$/i, "");
      const wiredInner = wireInputs(innerWithClose, register);
      const msg = /data-zurum-message/i.test(wiredInner) ? "" : `<p data-zurum-message style="margin:.5rem 0;color:#dc2626"></p>`;
      return `${newOpen}${wiredInner}${msg}</form>`;
    });
    return { html: out, hasAuth };
  } catch {
    // Never break a clone over wiring — fall back to whether a password field exists.
    return { html, hasAuth: /type\s*=\s*["']?password/i.test(html) };
  }
}
