/**
 * Pre-deploy security scan (ARCHITECTURE §14.4 L1) — a fast, deterministic pass
 * over a generated/cloned site BEFORE it goes live. It looks for the things that
 * would actually hurt a customer or Zurum's reputation:
 *   - leaked real secrets (payment/cloud/API keys, private keys) → BLOCK
 *   - dangerous script + insecure forms + mixed content → warn
 * The AI never freehands backend code (building blocks), so this focuses on the
 * static output. Cheap + no model call, so it can gate every publish.
 */

export type Severity = "critical" | "warn" | "info";
export interface Finding {
  severity: Severity;
  type: string;
  detail: string;
}
export interface ScanResult {
  critical: boolean;
  findings: Finding[];
}

// Unambiguous real-secret signatures → a leak, always block.
const SECRET_PATTERNS: { type: string; re: RegExp }[] = [
  { type: "flutterwave-secret", re: /FLWSECK[-_][A-Za-z0-9-]{10,}/ },
  { type: "stripe-secret", re: /\bsk_(live|test)_[A-Za-z0-9]{16,}/ },
  { type: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { type: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { type: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { type: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { type: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}/ },
  { type: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

export function scanSite(html: string): ScanResult {
  const findings: Finding[] = [];
  const add = (severity: Severity, type: string, detail: string): void => {
    findings.push({ severity, type, detail });
  };

  // 1) Leaked secrets — critical.
  for (const { type, re } of SECRET_PATTERNS) {
    const m = re.exec(html);
    if (m) add("critical", type, `possible ${type} in the page (…${m[0].slice(0, 6)}…)`);
  }
  // Generic "apiKey: 'longvalue'" — warn (could be a placeholder; don't block).
  if (/\b(api[_-]?key|secret|access[_-]?token|password)\b\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i.test(html)) {
    add("warn", "hardcoded-credential", "a credential-looking value is embedded in the page — double-check it's not a real key");
  }

  // 2) Dangerous script — warn (Forge shouldn't emit these).
  if (/\beval\s*\(/.test(html)) add("warn", "eval", "uses eval() — a code-injection smell");
  if (/\bnew\s+Function\s*\(/.test(html)) add("warn", "new-function", "uses new Function() — a code-injection smell");
  if (/document\.write\s*\(/.test(html)) add("info", "document-write", "uses document.write()");

  // 3) Insecure forms — a form posting over plain http leaks data.
  if (/<form\b[^>]*\baction\s*=\s*["']http:\/\//i.test(html)) {
    add("warn", "insecure-form", "a form submits over http:// (not https) — data could be intercepted");
  }

  // 4) Mixed content — http assets on a page that will be served over https.
  const mixed = [...html.matchAll(/\b(?:src|href)\s*=\s*["'](http:\/\/[^"']+)["']/gi)]
    .filter((m) => !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(m[1]!))
    .length;
  if (mixed > 0) add("warn", "mixed-content", `${mixed} asset(s) load over http:// — they may be blocked on an https site`);

  return { critical: findings.some((f) => f.severity === "critical"), findings };
}

/** One-line summary for logs / QA notes. */
export function summariseScan(r: ScanResult): string {
  if (!r.findings.length) return "security: clean";
  const c = r.findings.filter((f) => f.severity === "critical").length;
  const w = r.findings.filter((f) => f.severity === "warn").length;
  return `security: ${c} critical, ${w} warning(s)`;
}
