import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedAddress } from "../src/media/webref.js";
import { inferAction } from "../src/agents/aria.js";
import { referenceUrl, isLinkRequest } from "../src/app.js";
import { isComplete } from "../src/agents/forge.js";
import { staticChecks } from "../src/agents/guardian.js";
import { chatWidgetRequest } from "../src/config/embeds.js";

// ── SSRF guard (security-critical): internal addresses must be blocked ──
test("SSRF: blocks cloud metadata, loopback, private ranges", () => {
  for (const ip of [
    "169.254.169.254", // AWS/GCP metadata
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1", // CGNAT
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
});

test("SSRF: allows normal public addresses", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "142.250.72.14", "172.15.0.1", "172.32.0.1"]) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

// ── Aria intent classifier (the "silent build" bug) ──
test("Aria: build request is NEW, never swallowed as chat", () => {
  assert.equal(inferAction("build me an online banking website"), "new");
  assert.equal(inferAction("make me a different site, a photography portfolio"), "new");
  assert.equal(inferAction("create a landing page for my shop"), "new");
});

test("Aria: greetings/chitchat are chat, not edits", () => {
  assert.equal(inferAction("hello"), "chat");
  assert.equal(inferAction("how are you doing"), "chat");
  assert.equal(inferAction("thank you"), "chat");
});

test("Aria: change requests are edits; publish is approve; link is link", () => {
  assert.equal(inferAction("make the background green"), "edit");
  assert.equal(inferAction("add a booking section"), "edit");
  assert.equal(inferAction("looks great, publish it"), "approve");
  assert.equal(inferAction("send me the link to my site"), "link");
});

// Restyle/redesign requests must stay EDITS (same URL) — not new builds.
test("Aria: restyle/redesign of the current site stays an edit (same URL)", () => {
  assert.equal(inferAction("i don't like it, make it more modern and luxury"), "edit");
  assert.equal(inferAction("use real images and redesign the layout"), "edit");
  assert.equal(inferAction("make it more professional"), "edit");
  assert.equal(inferAction("change the whole colour scheme"), "edit");
});

// ── URL detection ──
test("referenceUrl: finds external links, ignores our own previews", () => {
  assert.equal(referenceUrl("clone https://apple.com please", "http://10.0.0.1:3000"), "https://apple.com");
  assert.equal(referenceUrl("no url here", "http://10.0.0.1:3000"), null);
  assert.equal(referenceUrl("http://10.0.0.1:3000/p/abc", "http://10.0.0.1:3000"), null);
});

test("isLinkRequest: matches asks for the site link, not 'add a link'", () => {
  assert.equal(isLinkRequest("send me the link to my site"), true);
  assert.equal(isLinkRequest("where is my website"), true);
  // From the live transcript — these used to slip through:
  assert.equal(isLinkRequest("send me my spa website link"), true);
  assert.equal(isLinkRequest("just the spa website link"), true);
  assert.equal(isLinkRequest("the link"), true);
  assert.equal(isLinkRequest("add a link to my instagram"), false);
  assert.equal(isLinkRequest("make the header blue"), false);
});

// ── Truncation detection (the multi-page failure) ──
test("isComplete: detects finished vs truncated documents", () => {
  assert.equal(isComplete("<!DOCTYPE html><html><body>hi</body></html>"), true);
  assert.equal(isComplete("<!DOCTYPE html><html><body>hi</body></html>\n  "), true);
  assert.equal(isComplete("<!DOCTYPE html><html><body>hi</bo"), false);
});

// ── Guardian static checks (self-containment + phishing backstop) ──
test("Guardian: flags external resources as critical", () => {
  const html = `<!DOCTYPE html><html><head><title>t</title><meta name="viewport" content="w">
    <script src="https://evil.example.com/x.js"></script></head><body>${"x".repeat(900)}</body></html>`;
  const r = staticChecks(html);
  assert.equal(r.critical, true);
});

test("Guardian: phishing backstop catches brand + password + harvest language", () => {
  const html = `<!DOCTYPE html><html><head><title>Bank of America</title><meta name="viewport" content="w"></head>
    <body><h1>Bank of America</h1><p>Please verify your account.</p>
    <input type="password"> ${"pad ".repeat(300)}</body></html>`;
  const r = staticChecks(html);
  assert.equal(r.critical, true);
});

test("Guardian: allows outbound links (WhatsApp chat, socials, maps)", () => {
  const html = `<!DOCTYPE html><html><head><meta name="viewport" content="w"><title>Shop</title></head>
    <body><h1>Shop</h1>
    <a href="https://wa.me/2348012345678">Chat with us</a>
    <a href="https://instagram.com/myshop">Instagram</a>
    <a href="tel:+2348012345678">Call</a>
    <p>${"Great products. ".repeat(60)}</p></body></html>`;
  const r = staticChecks(html);
  assert.equal(r.critical, false, "outbound links must not be blocked");
});

test("Guardian: allows many live-chat providers, blocks unknown scripts", () => {
  const base = `<!DOCTYPE html><html><head><meta name="viewport" content="w"><title>Shop</title></head><body><h1>Shop</h1><p>${"pad ".repeat(300)}</p>`;
  const allowed = [
    "https://code.tidio.co/abc123.js",
    "https://www.smartsuppchat.com/loader.js",
    "https://embed.tawk.to/123/default",
    "https://client.crisp.chat/l.js",
    "https://widget.intercom.io/widget/xyz",
    "https://static.zdassets.com/ekr/snippet.js",
    "https://wchat.freshchat.com/js/widget.js",
    "https://js.hs-scripts.com/123.js",
    "https://cdn.livechatinc.com/tracking.js",
    "https://code.jivosite.com/widget/abc",
    "https://static.landbot.io/landbot.js",
    "https://beacon-v2.helpscout.net/",
  ];
  for (const src of allowed) {
    const html = `${base}<script src="${src}"></script></body></html>`;
    assert.equal(staticChecks(html).critical, false, `${src} should be allowed`);
  }
  // Unknown third-party script → still blocked
  const sketchy = `${base}<script src="https://evil.example.com/x.js"></script></body></html>`;
  assert.equal(staticChecks(sketchy).critical, true, "unknown script must be blocked");
});

test("Guardian: allows real photos from image CDNs, still blocks other images + scripts", () => {
  const base = `<!DOCTYPE html><html><head><meta name="viewport" content="w"><title>Cafe</title></head><body><h1>Cafe</h1><p>${"pad ".repeat(300)}</p>`;
  // Pexels/Unsplash images (and CSS background) are allowed.
  const okImg = `${base}<img src="https://images.pexels.com/photos/1/x.jpg" alt="cafe">
    <div style="background-image:url('https://images.unsplash.com/photo-1')"></div></body></html>`;
  assert.equal(staticChecks(okImg).critical, false, "trusted CDN photos must be allowed");
  // An image from a random host is still blocked.
  const badImg = `${base}<img src="https://evil.example.com/x.jpg"></body></html>`;
  assert.equal(staticChecks(badImg).critical, true, "untrusted image host must be blocked");
  // A SCRIPT from an image CDN is NOT allowed (images only, no exec).
  const cdnScript = `${base}<script src="https://images.pexels.com/x.js"></script></body></html>`;
  assert.equal(staticChecks(cdnScript).critical, true, "scripts from image hosts must be blocked");
});

// ── Live-chat widget guidance ──
test("chatWidgetRequest: asks for the ID when a provider is named without one", () => {
  const r = chatWidgetRequest("please add tidio live chat to my site");
  assert.ok(r, "should detect a Tidio chat request");
  assert.equal(r!.name, "Tidio");
  assert.match(r!.steps, /Tidio/);
  assert.equal(chatWidgetRequest("add tawk.to chat")!.name, "Tawk.to");
});

test("chatWidgetRequest: stays quiet when the ID is already supplied", () => {
  assert.equal(chatWidgetRequest("add tidio chat, my key is a1b2c3d4e5"), null);
  assert.equal(chatWidgetRequest("add tidio chat ID: xyz12345"), null);
  assert.equal(
    chatWidgetRequest('add chat <script src="https://code.tidio.co/abc123.js"></script>'),
    null,
  );
});

test("chatWidgetRequest: ignores unrelated messages", () => {
  assert.equal(chatWidgetRequest("make the background green"), null);
  assert.equal(chatWidgetRequest("add a live chat"), null); // no provider named
});

test("Guardian: a normal self-contained site passes static checks", () => {
  const html = `<!DOCTYPE html><html lang="en"><head><meta name="viewport" content="width=device-width">
    <title>Sweet Crumbs Bakery</title><style>body{color:#333}</style></head>
    <body><h1>Sweet Crumbs</h1><p>${"Fresh bread daily. ".repeat(60)}</p></body></html>`;
  const r = staticChecks(html);
  assert.equal(r.critical, false);
});
