import { matchers, routes, type Transform, type VercelConfig } from "@vercel/config/v1";

// Otter Code publishes only nightlies, which alias code.otterware.app directly, so the
// channel router sits on a host that never receives traffic.
const ROUTER_HOST = "router.code.otterware.app";
const HOSTED_WEB_CHANNEL_COOKIE = "t3code_web_channel";
const LATEST_ORIGIN = "https://latest.code.otterware.app";
const NIGHTLY_ORIGIN = "https://nightly.code.otterware.app";
const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export const config: VercelConfig = {
  buildCommand:
    'vp run --filter @t3tools/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@t3tools/scripts...' --filter '@t3tools/web...'",
  headers: [
    {
      source: "/account/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "no-store" },
      ],
    },
  ],
  routes: [
    ...["code.otterware.dev", "latest.code.otterware.dev", "nightly.code.otterware.dev"].map(
      (host) => ({
        src: "/(.*)",
        has: [matchers.host(host)],
        headers: {
          Location: `${host === "latest.code.otterware.dev" ? LATEST_ORIGIN : "https://code.otterware.app"}/$1`,
        },
        status: 308,
      }),
    ),
    {
      src: "/__t3code/channel",
      has: [matchers.query("channel", "nightly")],
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("nightly"),
      },
      status: 302,
    },
    {
      src: "/__t3code/channel",
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("latest"),
      },
      status: 302,
    },
    {
      src: "/(.*)",
      has: [matchers.host(ROUTER_HOST), matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly")],
      dest: `${NIGHTLY_ORIGIN}/$1`,
    },
    {
      src: "/(.*)",
      has: [matchers.host(ROUTER_HOST)],
      dest: `${LATEST_ORIGIN}/$1`,
    },
  ],
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
