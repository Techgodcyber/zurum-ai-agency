import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPreviewChrome, expiredPreviewPage } from "../src/launch/preview-chrome.js";

test("watermark: injects the preview banner before </body>", () => {
  const out = applyPreviewChrome("<html><body><h1>Hi</h1></body></html>");
  assert.match(out, /zurum-preview-badge/);
  assert.match(out, /PREVIEW/i);
  // Banner sits inside the body, just before the close tag.
  assert.ok(out.indexOf("zurum-preview-badge") < out.lastIndexOf("</body>"));
});

test("watermark: never injected twice (idempotent)", () => {
  const once = applyPreviewChrome("<body></body>");
  const twice = applyPreviewChrome(once);
  assert.equal(twice, once); // second call is a no-op
  assert.equal((once.match(/id="zurum-preview-badge"/g) ?? []).length, 1);
});

test("watermark: appends when there is no </body>", () => {
  const out = applyPreviewChrome("<h1>no body tag</h1>");
  assert.match(out, /zurum-preview-badge/);
});

test("expired page: is a self-contained restore prompt", () => {
  const p = expiredPreviewPage();
  assert.match(p, /expired/i);
  assert.match(p, /publish/i);
  assert.doesNotMatch(p, /<script/i); // no scripts
});
