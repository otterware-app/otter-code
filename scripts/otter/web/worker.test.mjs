import * as NodeAssert from "node:assert/strict";
import { test } from "vitest";
import worker from "./worker.mjs";

test("old domains redirect with the original path and query, including callback codes", async () => {
  for (const [host, target] of [
    ["code.otterware.dev", "code.otterware.app"],
    ["latest.code.otterware.dev", "latest.code.otterware.app"],
    ["nightly.code.otterware.dev", "code.otterware.app"],
  ]) {
    const response = await worker.fetch(
      new Request(`https://${host}/account/callback?code=test-code&state=test-state`),
      {},
    );
    NodeAssert.equal(response.status, 308);
    NodeAssert.equal(
      response.headers.get("location"),
      `https://${target}/account/callback?code=test-code&state=test-state`,
    );
  }
});

test("callback and sign-out pages cannot be cached, framed, or leak their referrer", async () => {
  for (const path of ["/account/callback?code=test-code", "/account/sign-out"]) {
    const response = await worker.fetch(new Request(`https://code.otterware.app${path}`), {
      ASSETS: {
        fetch: async () =>
          new Response("<html>app</html>", { headers: { "content-type": "text/html" } }),
      },
    });
    NodeAssert.equal(response.headers.get("cache-control"), "no-store");
    NodeAssert.equal(response.headers.get("referrer-policy"), "no-referrer");
    NodeAssert.equal(response.headers.get("x-frame-options"), "DENY");
    NodeAssert.equal(await response.text(), "<html>app</html>");
  }
});

test("HTML revalidates across releases and asset failures keep their status", async () => {
  const request = new Request("https://code.otterware.app/settings/connections");
  const response = await worker.fetch(request, {
    ASSETS: {
      fetch: async () =>
        new Response("app", { headers: { "content-type": "text/html", etag: "build-one" } }),
    },
  });
  NodeAssert.equal(response.headers.get("cache-control"), "no-cache");
  NodeAssert.equal(response.headers.get("etag"), "build-one");
  const missing = await worker.fetch(request, {
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
  });
  NodeAssert.equal(missing.status, 404);
});

test("hashed assets stay cacheable and missing chunks do not become cached HTML", async () => {
  const request = new Request("https://code.otterware.app/assets/main-build.js");
  const response = await worker.fetch(request, {
    ASSETS: {
      fetch: async () =>
        new Response("export {}", { headers: { "content-type": "text/javascript" } }),
    },
  });
  NodeAssert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const missing = await worker.fetch(request, {
    ASSETS: {
      fetch: async () => new Response("app", { headers: { "content-type": "text/html" } }),
    },
  });
  NodeAssert.equal(missing.status, 404);
  NodeAssert.equal(missing.headers.get("cache-control"), "no-store");
});

test("channel selection sets a host-only cookie and returns to the app without an open redirect", async () => {
  for (const [query, channel] of [
    ["nightly", "nightly"],
    ["https://evil.example", "latest"],
  ]) {
    const response = await worker.fetch(
      new Request(
        `https://code.otterware.app/__t3code/channel?channel=${encodeURIComponent(query)}`,
      ),
      {},
    );
    NodeAssert.equal(response.status, 302);
    NodeAssert.equal(response.headers.get("location"), "/");
    NodeAssert.equal(response.headers.get("cache-control"), "no-store");
    NodeAssert.equal(
      response.headers.get("set-cookie"),
      `t3code_web_channel=${channel}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
    );
  }
});
