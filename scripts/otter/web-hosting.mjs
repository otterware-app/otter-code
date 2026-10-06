import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const config = "scripts/otter/web/wrangler.json";
const required = (key) => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};
const run = (command, args, env = {}) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
};
const wrangler = (args, env, deploymentConfig = config) =>
  run("pnpm", ["dlx", "wrangler@4.147.0", ...args, "--config", deploymentConfig], env);
const output = async (values) => {
  if (process.env.GITHUB_OUTPUT) {
    await NodeFSP.appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
  console.log(JSON.stringify(values));
};

const verify = async (origin) => {
  const request = (path) =>
    fetch(new URL(path, origin), {
      headers: { "Sec-Fetch-Mode": "navigate", Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
  const page = await request("/settings/connections");
  if (page.status !== 200 || !page.headers.get("content-type")?.includes("text/html"))
    throw new Error("Cloudflare SPA navigation failed");
  const html = await page.text();
  const script = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  if (!script || !script.startsWith("/assets/")) throw new Error("Missing built web entry point");
  const asset = await fetch(new URL(script, origin), { signal: AbortSignal.timeout(30_000) });
  if (asset.status !== 200 || !asset.headers.get("cache-control")?.includes("immutable"))
    throw new Error("Cloudflare static asset serving failed");
  await asset.body?.cancel();
  const callback = await request("/account/callback");
  if (
    callback.status !== 200 ||
    callback.headers.get("cache-control") !== "no-store" ||
    callback.headers.get("referrer-policy") !== "no-referrer" ||
    callback.headers.get("x-frame-options") !== "DENY"
  )
    throw new Error("Cloudflare account callback headers failed");
  await callback.body?.cancel();
  console.log(`Verified ${origin}: SPA navigation, static assets, account callback headers`);
};

const [action] = process.argv.slice(2);
if (action === "stage" || action === "stage-preview") {
  const preview = action === "stage-preview";
  const version = preview
    ? JSON.parse(await NodeFSP.readFile(NodePath.join(root, "apps/web/package.json"), "utf8"))
        .version
    : required("APP_VERSION");
  if (!/^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("Invalid app version");
  const channel = process.env.VITE_HOSTED_APP_CHANNEL || "nightly";
  if (!["nightly", "latest"].includes(channel)) throw new Error("Invalid hosted channel");
  run("vp", ["run", "--filter", "@t3tools/web", "build"], {
    APP_VERSION: version,
    VITE_HOSTED_APP_URL: "https://code.otterware.app",
    VITE_HOSTED_APP_CHANNEL: channel,
    T3CODE_WEB_SOURCEMAP: "false",
  });
  run("node", ["scripts/apply-web-brand-assets.ts", "--channel", channel]);
  const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "otter-code-web-"));
  try {
    const workerName = preview ? "otter-code-web-preview" : "otter-code-web";
    const configuration = JSON.parse(await NodeFSP.readFile(NodePath.join(root, config), "utf8"));
    const existing = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${configuration.account_id}/workers/scripts/${workerName}/settings`,
      {
        headers: { Authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    await existing.body?.cancel();
    if (existing.status === 404) {
      // The first Worker version must be deployed. Bootstrap only workers.dev;
      // custom domains remain on their current host until promotion.
      const bootstrap = NodePath.join(temporary, "bootstrap.json");
      await NodeFSP.writeFile(
        bootstrap,
        JSON.stringify({
          ...configuration,
          name: workerName,
          main: NodePath.join(root, "scripts/otter/web/worker.mjs"),
          assets: { ...configuration.assets, directory: NodePath.join(root, "apps/web/dist") },
          routes: [],
        }),
      );
      wrangler(["deploy"], {}, bootstrap);
    } else if (!existing.ok) {
      throw new Error(`Cannot inspect Cloudflare web Worker (${existing.status})`);
    }
    const journal = NodePath.join(temporary, "wrangler.jsonl");
    wrangler(
      [
        "versions",
        "upload",
        ...(preview ? ["--name", "otter-code-web-preview"] : []),
        "--tag",
        version,
        "--message",
        `Otter Code ${version}`,
      ],
      {
        WRANGLER_OUTPUT_FILE_PATH: journal,
      },
    );
    const record = (await NodeFSP.readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .findLast((entry) => entry.type === "version-upload");
    if (!record?.version_id || !record.preview_url)
      throw new Error("Cloudflare did not return a staged version and preview URL");
    await verify(record.preview_url);
    await output({ version_id: record.version_id, deployment_url: record.preview_url });
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
} else if (action === "promote") {
  const versionId = required("WEB_VERSION_ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(versionId))
    throw new Error("Invalid Worker version ID");
  const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "otter-code-promote-"));
  try {
    const configuration = JSON.parse(await NodeFSP.readFile(NodePath.join(root, config), "utf8"));
    // Promotion runs in a fresh release job. Assets are already in the staged
    // Worker version; synchronizing its domains must not require a local build.
    delete configuration.assets;
    configuration.main = NodePath.join(root, "scripts/otter/web/worker.mjs");
    const promotionConfig = NodePath.join(temporary, "wrangler.json");
    await NodeFSP.writeFile(promotionConfig, JSON.stringify(configuration));
    wrangler(["versions", "deploy", `${versionId}@100%`, "--yes"], {}, promotionConfig);
    wrangler(["triggers", "deploy"], {}, promotionConfig);
    await verify("https://code.otterware.app");
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
} else {
  throw new Error("Usage: node scripts/otter/web-hosting.mjs <stage|stage-preview|promote>");
}
