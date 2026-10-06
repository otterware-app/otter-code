const oldHosts = new Map([
  ["code.otterware.dev", "code.otterware.app"],
  ["latest.code.otterware.dev", "latest.code.otterware.app"],
  ["nightly.code.otterware.dev", "code.otterware.app"],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const destination = oldHosts.get(url.hostname);
    if (destination) {
      url.protocol = "https:";
      url.host = destination;
      return new Response(null, {
        status: 308,
        headers: {
          Location: url.href,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    if (url.pathname === "/__t3code/channel") {
      const channel = url.searchParams.get("channel") === "nightly" ? "nightly" : "latest";
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Cache-Control": "no-store",
          "Set-Cookie": `t3code_web_channel=${channel}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    if (url.pathname.startsWith("/assets/")) {
      if (headers.get("content-type")?.includes("text/html")) {
        return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      if (response.ok) headers.set("Cache-Control", "public, max-age=31536000, immutable");
    } else if (url.pathname.startsWith("/account/")) {
      headers.set("X-Frame-Options", "DENY");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("Cache-Control", "no-store");
    } else if (headers.get("content-type")?.includes("text/html")) {
      headers.set("Cache-Control", "no-cache");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
