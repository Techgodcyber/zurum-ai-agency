import { getNum } from "../config/settings.js";
import {
  checkBuild,
  isAdminIdentity,
  editsUsed,
  consumeFreeEdit,
  refundFreeEdit,
  consumeBuild,
  refundBuild,
} from "./quota.js";
import { getBalance, spend, refund } from "./credits.js";

/**
 * Metering brain. Decides how a paid action is covered — free allowance first,
 * then the credit wallet, else blocked with a top-up prompt — and applies or
 * reverses the charge. Composes the quota (free counts) and credits (wallet)
 * layers so the app just asks "can they, and how?".
 */

export type Charge = "exempt" | "free" | "credit";

export interface Decision {
  allowed: boolean;
  mode?: Charge;
  balance: number;
  cost: number; // credits, when mode === "credit"
  freeLeft: number; // remaining free actions of this kind
}

// ── Edits ────────────────────────────────────────────────

export async function checkEditMeter(
  userId: string,
  channel: string,
  externalId: string,
): Promise<Decision> {
  const balance = await getBalance(userId);
  const cost = getNum("edit_cost_credits");
  if (isAdminIdentity(channel, externalId)) {
    return { allowed: true, mode: "exempt", balance, cost, freeLeft: Infinity };
  }
  const freeLeft = Math.max(getNum("free_edit_limit") - (await editsUsed(userId)), 0);
  if (freeLeft > 0) return { allowed: true, mode: "free", balance, cost, freeLeft };
  if (balance >= cost) return { allowed: true, mode: "credit", balance, cost, freeLeft: 0 };
  return { allowed: false, balance, cost, freeLeft: 0 };
}

// ── Builds (extra sites beyond the free ones) ────────────

export async function checkBuildMeter(
  userId: string,
  channel: string,
  externalId: string,
): Promise<Decision> {
  const balance = await getBalance(userId);
  const cost = getNum("build_cost_credits");
  const q = await checkBuild(userId, channel, externalId);
  if (q.allowed) {
    return {
      allowed: true,
      mode: q.unlimited ? "exempt" : "free",
      balance,
      cost,
      freeLeft: q.limit == null ? Infinity : Math.max(q.limit - q.used, 0),
    };
  }
  if (balance >= cost) return { allowed: true, mode: "credit", balance, cost, freeLeft: 0 };
  return { allowed: false, balance, cost, freeLeft: 0 };
}

// ── Apply / reverse ──────────────────────────────────────

/** Apply a charge. Returns whether it dropped the customer to a low balance. */
export interface ChargeResult {
  lowWarning: boolean;
  balance: number;
}

export async function applyEditCharge(userId: string, mode: Charge): Promise<ChargeResult> {
  if (mode === "credit") {
    const r = await spend(userId, getNum("edit_cost_credits"), "edit");
    return { lowWarning: r.lowWarning, balance: r.balance };
  }
  if (mode === "free") await consumeFreeEdit(userId);
  return { lowWarning: false, balance: await getBalance(userId) };
}
export async function reverseEditCharge(userId: string, mode: Charge): Promise<void> {
  if (mode === "free") await refundFreeEdit(userId);
  else if (mode === "credit") await refund(userId, getNum("edit_cost_credits"));
}
export async function applyBuildCharge(userId: string, mode: Charge): Promise<ChargeResult> {
  if (mode === "credit") {
    const r = await spend(userId, getNum("build_cost_credits"), "extra site");
    return { lowWarning: r.lowWarning, balance: r.balance };
  }
  if (mode === "free") await consumeBuild(userId);
  return { lowWarning: false, balance: await getBalance(userId) };
}
export async function reverseBuildCharge(userId: string, mode: Charge): Promise<void> {
  if (mode === "free") await refundBuild(userId);
  else if (mode === "credit") await refund(userId, getNum("build_cost_credits"));
}

/** Customer-facing low-balance nudge (real text; the voice layer warms/translates). */
export function lowCreditMeaning(balance: number, minUsd: number): string {
  return `Heads up — you're running low on credits (${balance} left) 🔔 Top up from $${minUsd} so you don't get interrupted mid-build. Your site stays live in the meantime.`;
}

// ── Intent detection (pure) ──────────────────────────────

export function isTopupRequest(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(top\s?up|recharge)\b/.test(t) ||
    /\b(buy|get|purchase|load|want|need|add|more)\s+(me\s+)?(more\s+)?credits?\b/.test(t) ||
    /\bmore\s+edits?\b/.test(t) ||
    /\bfund(ing)?\s+(my\s+)?(account|wallet|balance)\b/.test(t) ||
    /\badd\s+(money|funds?|cash|credits?)\b/.test(t) ||
    // "how do i add money / pay / top up / fund my account"
    /\bhow\s+(do\s+i|can\s+i|to)\s+(pay|add\s+(money|funds?|credits?)|top\s?up|fund|recharge)\b/.test(t) ||
    /\bpay\s+for\s+(more|credits?|building|a?\s*website)\b/.test(t)
  );
}
/** Parse "send/transfer/gift 20 credits to <recipient>" → amount + recipient. */
export function parseTransfer(text: string): { amount: number; recipient: string } | null {
  const m = text.match(/\b(?:send|transfer|gift|give)\s+(\d+)\s+credits?\s+to\s+(\S+)/i);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isInteger(amount) || amount <= 0) return null;
  return { amount, recipient: m[2]!.replace(/[.,]+$/, "") };
}

/**
 * A question about the customer's sites — how many they've BUILT (past) or CAN
 * build (future), or "does N credits get me M sites". Answered from real numbers.
 * (Runs after the balance check, so plain "how many credits" is handled there.)
 */
export function isSitesCountQuestion(text: string): boolean {
  const t = text.toLowerCase();
  return (
    (/\bhow many\b/.test(t) &&
      /\b(websites?|sites?|web\s?sites?|built?|build|create[d]?|made|make)\b/.test(t)) ||
    /\b(does|do|will|can|would|is)\b[^?]*\bcredits?\b[^?]*\b(websites?|sites?)\b/.test(t) ||
    /\bcredits?\b[^?]*\b(get|build|make|give)\b[^?]*\b(websites?|sites?)\b/.test(t)
  );
}

export function isBalanceRequest(text: string): boolean {
  return /\b(balance|how\s+(many|much)\s+credits?|how much (is|do i have)|credits?\s+(left|remaining|balance)|(do\s+i|i)\s+(still\s+)?have\s+(any\s+)?credits?|check.{0,12}credits?)\b/i.test(
    text,
  );
}

// ── MEANINGS (voice layer) ───────────────────────────────

// NOTE: these return REAL customer-facing text (a draft the voice layer warms and
// translates). Never phrase them as instructions — if phrasing fails, the draft
// itself is shown, so it must read as a message to the customer.

export function editBlockedMeaning(balance: number, cost: number, minUsd: number): string {
  return `You've used all your free edits 🙌 Each edit now costs ${cost} credit${cost > 1 ? "s" : ""}, and your balance is ${balance}. Top up from $${minUsd} to keep editing — your website stays live in the meantime.`;
}

export function buildBlockedMeaning(cost: number, balance: number, minUsd: number): string {
  return `You've used up your free websites 🙌 A new one costs ${cost} credits and your balance is ${balance}. Top up from $${minUsd} to build more — your existing sites stay live and editable.`;
}

/** A 10-segment usage bar, e.g. "▓▓▓░░░░░░░ 30%". */
function usageBar(used: number, limit: number): string {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const filled = Math.round(pct / 10);
  return `${"▓".repeat(filled)}${"░".repeat(10 - filled)} ${pct}% used`;
}

/**
 * A visual "wallet" card the customer sees when they check their balance: credits,
 * plus free edits/sites usage bars. `unlimited` (admins) skips the bars.
 */
export function walletCard(o: {
  credits: number;
  editsUsed: number;
  editLimit: number;
  buildsUsed: number;
  buildLimit: number | null;
  unlimited: boolean;
}): string {
  const lines = ["💳 Your Zurum Wallet", "━━━━━━━━━━━━━━━━━━", `🪙 Credits: ${o.credits}`];
  if (o.unlimited) {
    lines.push("✨ Edits & sites: unlimited (admin)");
    return lines.join("\n");
  }
  const editLeft = Math.max(o.editLimit - o.editsUsed, 0);
  lines.push(`✏️ Free edits: ${editLeft} of ${o.editLimit} left`, `   ${usageBar(o.editsUsed, o.editLimit)}`);
  if (o.buildLimit !== null) {
    const buildLeft = Math.max(o.buildLimit - o.buildsUsed, 0);
    lines.push(`🌐 Free sites: ${buildLeft} of ${o.buildLimit} left`, `   ${usageBar(o.buildsUsed, o.buildLimit)}`);
  }
  lines.push("", "Need more? Tap a top-up below 👇");
  return lines.join("\n");
}

export function balanceMeaning(balance: number, freeEditsLeft: number): string {
  const edits = `${freeEditsLeft} free edit${freeEditsLeft === 1 ? "" : "s"}`;
  let tail: string;
  if (freeEditsLeft > 0) {
    tail = ` — your edits are free until those run out, then each edit is ${getNum("edit_cost_credits")} credit.`;
  } else if (balance === 0) {
    tail = ` You're out — top up from $${getNum("min_topup_usd")} to keep editing or build more.`;
  } else {
    tail = ` — each edit costs ${getNum("edit_cost_credits")} credit.`;
  }
  return `You have ${balance} credits and ${edits} left.${tail}`;
}
