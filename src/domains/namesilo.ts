import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

/**
 * Namesilo registrar client (reseller). Handles availability, live prices, and
 * registration/renewal/transfer-code. Gated on NAMESILO_API_KEY — absent, the
 * app never calls this and answers domain requests honestly instead.
 *
 * Founder rules baked in: register with private=1 (free WHOIS privacy) and
 * auto_renew=0 — Namesilo must NEVER auto-deduct from the reseller wallet; we
 * remind the customer to renew instead.
 *
 * NOTE: XML shapes below follow Namesilo's documented API; confirm against the
 * live account before going to production (same posture as provider model IDs).
 */

const log = logger.child({ mod: "namesilo" });

export function isNamesiloConfigured(): boolean {
  return Boolean(env.NAMESILO_API_KEY);
}

/** Build a Namesilo API URL (version/type/key always included). */
export function buildUrl(op: string, params: Record<string, string> = {}): string {
  const qs = new URLSearchParams({
    version: "1",
    type: "xml",
    key: env.NAMESILO_API_KEY ?? "",
    ...params,
  });
  return `${env.NAMESILO_BASE_URL}/${op}?${qs.toString()}`;
}

export interface Availability {
  domain: string;
  status: "available" | "taken" | "invalid";
  /** Registrar cost (USD/year) when available — our fee is added on top later. */
  cost?: number;
}

/** Parse a checkRegisterAvailability XML reply into per-domain results. */
export function parseAvailability(xml: string): Availability[] {
  const out: Availability[] = [];
  const grab = (block: string, status: Availability["status"]) => {
    const section = xml.match(new RegExp(`<${block}>([\\s\\S]*?)</${block}>`, "i"))?.[1] ?? "";
    for (const m of section.matchAll(/<domain([^>]*)>([^<]+)<\/domain>/gi)) {
      const price = (m[1] ?? "").match(/price="([\d.]+)"/i)?.[1];
      out.push({
        domain: m[2]!.trim().toLowerCase(),
        status,
        cost: price ? Number(price) : undefined,
      });
    }
  };
  grab("available", "available");
  grab("unavailable", "taken");
  grab("invalid", "invalid");
  return out;
}

/** Per-TLD registration cost from a getPrices reply, keyed by bare TLD ("com"). */
export function parsePrices(xml: string): Record<string, number> {
  const reply = xml.match(/<reply>([\s\S]*?)<\/reply>/i)?.[1] ?? xml;
  const out: Record<string, number> = {};
  for (const m of reply.matchAll(
    /<([a-z0-9.]+)>\s*<registration>([\d.]+)<\/registration>/gi,
  )) {
    out[m[1]!.toLowerCase()] = Number(m[2]);
  }
  return out;
}

/** The status code + detail from any Namesilo reply (300 = success). */
export function replyCode(xml: string): { code: string; detail: string } {
  return {
    code: xml.match(/<code>(\d+)<\/code>/i)?.[1] ?? "",
    detail: xml.match(/<detail>([^<]*)<\/detail>/i)?.[1] ?? "",
  };
}

async function call(
  op: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  if (!env.NAMESILO_API_KEY) throw new Error("Namesilo not configured");
  const res = await fetch(buildUrl(op, params), {
    signal: signal ?? AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`namesilo ${op} → ${res.status}`);
  return res.text();
}

/** Check one domain's availability + registrar cost. */
export async function checkAvailability(
  domain: string,
  signal?: AbortSignal,
): Promise<Availability> {
  const xml = await call("checkRegisterAvailability", { domains: domain }, signal);
  return parseAvailability(xml)[0] ?? { domain: domain.toLowerCase(), status: "invalid" };
}

/** Live registration cost for a TLD (e.g. "com"), or null if unknown. */
export async function getRegistrationCost(
  tld: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const xml = await call("getPrices", {}, signal);
  return parsePrices(xml)[tld.replace(/^\./, "").toLowerCase()] ?? null;
}

/**
 * Register a domain for the customer. private=1 (free WHOIS privacy),
 * auto_renew=0 (never auto-charge the wallet — we remind instead).
 */
export async function registerDomain(
  domain: string,
  years = 1,
  signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const xml = await call(
    "registerDomain",
    { domain, years: String(years), private: "1", auto_renew: "0" },
    signal,
  );
  const { code, detail } = replyCode(xml);
  log.info({ domain, code }, "namesilo register");
  return { ok: code === "300", detail };
}

/** Send the transfer/EPP auth code so the customer can move the domain out. */
export async function retrieveAuthCode(
  domain: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const xml = await call("retrieveAuthCode", { domain }, signal);
  const { code, detail } = replyCode(xml);
  return { ok: code === "300", detail };
}

/** Renew a domain N years — only when the customer has paid (never automatic). */
export async function renewDomain(
  domain: string,
  years = 1,
  signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const xml = await call(
    "renewDomain",
    { domain, years: String(years), auto_renew: "0" },
    signal,
  );
  const { code, detail } = replyCode(xml);
  return { ok: code === "300", detail };
}
