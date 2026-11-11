import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { readSiteFiles } from "../sites/store.js";
import { canonRoute, fileOf } from "../sites/routes.js";
import { getHosting } from "../launch/hosting-store.js";
import { handleFormPost } from "../forms/handler.js";
import { handleAdmin } from "../admin/server.js";
import { handleApi } from "../backend/service.js";
import { handlePanel } from "../panel/server.js";
import type { ChannelHub } from "../channels/index.js";
import type { MetaWebhook } from "../channels/whatsapp.js";

const log = logger.child({ mod: "web" });

/** First non-internal IPv4 address, so a phone on the same wi-fi can open links. */
function lanIp(): string {
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

/**
 * Base URL preview/form/admin links are built from. Prefers PUBLIC_BASE_URL (the
 * real hosted domain); otherwise the machine's LAN address for local testing.
 */
export const BASE_URL = env.PUBLIC_BASE_URL ?? `http://${lanIp()}:${env.PORT}`;

export function previewUrlFor(siteId: string): string {
  return `${BASE_URL}/p/${siteId}`;
}

/**
 * Re-scope a cloned page's root-relative internal links (href="/login") under
 * the shared preview prefix (href="/p/:id/login") so multi-page navigation works
 * in the local preview. Leaves external and protocol-relative links untouched.
 * (The real hosted site lives at a domain root, so it never needs this.)
 */
function scopePreviewLinks(html: string, siteId: string): string {
  return html.replace(
    /(\shref=)(["'])\/(?!\/)([^"']*)\2/gi,
    (_m, pre: string, q: string, rest: string) => `${pre}${q}/p/${siteId}/${rest}${q}`,
  );
}

/** Where a generated site's forms POST to (the light-dynamic tier). */
export function formEndpointFor(siteId: string): string {
  return `${BASE_URL}/f/${siteId}`;
}

function send(res: ServerResponse, code: number, body: string, type = "text/plain") {
  res.writeHead(code, { "content-type": `${type}; charset=utf-8` });
  res.end(body);
}

/** Read a bounded JSON request body; returns null if missing/oversized/invalid. */
async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) return null;
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** The public WhatsApp Callback URL to register in the Meta app dashboard. */
export function whatsappWebhookUrl(): string {
  return `${BASE_URL}/webhooks/whatsapp/${env.WHATSAPP_WEBHOOK_TOKEN}/inbound`;
}

/**
 * The web server: local site previews, live form submissions, and the admin
 * control centre. Real hosting serves customer sites; this serves everything
 * Zurum itself needs a URL for.
 */
export function startPreviewServer(hub?: ChannelHub): Server {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";

    try {
      // Admin control centre, mounted at a (possibly secret) prefix. Anything
      // else — including a guessed /admin — falls through to a plain 404, so
      // scanners can't tell the panel exists.
      if (path === env.ADMIN_PATH || path.startsWith(`${env.ADMIN_PATH}/`)) {
        await handleAdmin(req, res);
        return;
      }

      // Customer-site backend (§14): register/login + dashboard data for the
      // sites Zurum builds. Multi-tenant, scoped by siteId in the path.
      if (path.startsWith("/api/")) {
        await handleApi(req, res, path, hub);
        return;
      }

      // The customer's own dashboard (§9): /login is the phone→WhatsApp-OTP web
      // login, /me/:token the magic link from chat, /dashboard the logged-in app.
      if (
        path === "/login" || path.startsWith("/login/") ||
        path === "/me" || path.startsWith("/me/") ||
        path === "/dashboard" || path.startsWith("/dashboard/")
      ) {
        await handlePanel(req, res, path, hub);
        return;
      }

      // WhatsApp (Meta Cloud API) webhook. The secret token in the path means
      // only Meta — configured with this exact URL — reaches it. Meta first GETs
      // it to verify (echo hub.challenge), then POSTs messages.
      const wh = /^\/webhooks\/whatsapp\/([^/]+)\/inbound$/.exec(path);
      if (wh) {
        if (!hub?.whatsappConfigured() || wh[1] !== env.WHATSAPP_WEBHOOK_TOKEN) {
          send(res, 404, "Not found");
          return;
        }
        const query = new URLSearchParams(url.split("?")[1] ?? "");
        if (req.method === "GET") {
          // Verification handshake.
          const challenge = hub.verifyWhatsAppWebhook(
            query.get("hub.mode"),
            query.get("hub.verify_token"),
            query.get("hub.challenge"),
          );
          if (challenge === null) send(res, 403, "Forbidden");
          else send(res, 200, challenge);
          return;
        }
        if (req.method !== "POST") {
          send(res, 405, "Method not allowed");
          return;
        }
        const payload = await readJson<MetaWebhook>(req);
        send(res, 200, "ok"); // ack immediately so Meta doesn't retry/duplicate
        if (payload) {
          void hub
            .deliverWhatsApp(payload)
            .catch((err) => log.error({ err }, "whatsapp inbound failed"));
        }
        return;
      }

      // Form submissions from generated sites.
      const form = /^\/f\/([\w-]+)\/?$/.exec(path);
      if (form) {
        if (req.method !== "POST") {
          send(res, 405, "Method not allowed");
          return;
        }
        await handleFormPost(form[1]!, req, res, hub);
        return;
      }

      // Local site preview. Matches the homepage (/p/:id) and any sub-page of a
      // cloned multi-page site (/p/:id/login, /p/:id/register/, …).
      const preview = /^\/p\/([\w-]+)(?:\/(.*))?$/.exec(path);
      if (preview) {
        const siteId = preview[1]!;
        const sub = preview[2] ?? "";
        const hosting = await getHosting(siteId);
        if (hosting?.suspended) {
          send(res, 410, "This site has been suspended.", "text/html");
          return;
        }
        const files = await readSiteFiles(siteId);
        if (!files) {
          send(res, 404, "Site not found or still building.");
          return;
        }
        // Map the requested sub-path to a stored page; fall back to the homepage.
        const wantKey = fileOf(canonRoute("/" + sub));
        const page = files.get(wantKey) ?? files.get("/index.html") ?? [...files.values()][0]!;
        // Cloned pages link by root-relative route (/login); under the shared
        // /p/:id preview prefix those must be re-scoped so navigation stays on
        // the preview (the real hosted site sits at a domain root, so it's fine
        // there). Only rewrites same-site links, never protocol-relative/external.
        const scoped = files.size > 1 ? scopePreviewLinks(page, siteId) : page;
        send(res, 200, scoped, "text/html");
        return;
      }

      if (path === "/health") {
        send(res, 200, "ok");
        return;
      }

      send(res, 404, "Not found");
    } catch (err) {
      log.error({ err, url }, "request failed");
      if (!res.headersSent) send(res, 500, "Server error");
      else res.end();
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(
        { port: env.PORT },
        "port already in use — another Zurum instance is likely running; stop it first",
      );
    } else {
      log.error({ err }, "web server error");
    }
    process.exit(1);
  });

  server.listen(env.PORT, () => {
    log.info(
      {
        baseUrl: BASE_URL,
        admin: `${BASE_URL}${env.ADMIN_PATH}`,
        whatsappWebhook: hub?.whatsappConfigured() ? whatsappWebhookUrl() : "off",
      },
      "web server listening",
    );
  });
  return server;
}
