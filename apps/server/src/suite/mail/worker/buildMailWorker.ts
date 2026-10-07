#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- A build step, run outside any Effect runtime.
/**
 * Bundles Mail's worker (`mailWorker.ts` over vendored Otter Mail) into one
 * ES module Node runs as a worker thread. Vendored Mail imports `.js` paths of
 * `.ts` files, its desktop services import Electron-side modules this swaps
 * for `./shims`, and Mail's build-time defines are set here, so a bundler has
 * to run; plain `node src/bin.ts` can't load Mail directly.
 *
 * - `vp run build:bundle` (apps/server) writes `dist/otter-mail-worker.mjs`:
 *   `node src/suite/mail/worker/buildMailWorker.ts dist/otter-mail-worker.mjs`.
 * - Dev servers build into node_modules/.cache on first use and reuse the
 *   bundle until one of its inputs changes (`ensureDevMailWorker`).
 *
 * Google sign-in needs OTTER_MAIL_GOOGLE_CLIENT_SECRET (and optionally the
 * client id) at build time or at runtime; without them Mail says so.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const WORKER_DIR = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const ROOT = NodePath.resolve(WORKER_DIR, "../../../../../..");
const VENDOR = NodePath.join(ROOT, "vendor/otter-mail");
const DESKTOP_SERVICES = NodePath.join(VENDOR, "apps/desktop/src/services");

/** Otter Mail's public Google OAuth client ("Desktop app"); its secret is never committed. */
const PUBLIC_GOOGLE_CLIENT_ID =
  "997327858649-n30jr99d21200libki4bgeojpr1kfq59.apps.googleusercontent.com";

const SHIMS: Readonly<Record<string, string>> = {
  "../main-link.js": NodePath.join(WORKER_DIR, "shims/mainLink.ts"),
  "../backend-protocol.js": NodePath.join(WORKER_DIR, "shims/backendProtocol.ts"),
};

function vendoredVersion(): string {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(VENDOR, "apps/web/package.json"), "utf8"),
  ) as { version?: string };
  return manifest.version ?? "0.0.0";
}

/** `@otter-mail/<pkg>[/<sub>]` through the vendored package's `exports`. */
function resolveVendoredPackage(source: string): string | null {
  const match = /^@otter-mail\/([^/]+)(\/.*)?$/.exec(source);
  if (!match) return null;
  const dir = NodePath.join(VENDOR, "packages", match[1]!);
  const manifestPath = NodePath.join(dir, "package.json");
  if (!NodeFS.existsSync(manifestPath)) return null;
  const exports = (
    JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
      exports?: Record<string, string>;
    }
  ).exports;
  const target = exports?.[`.${match[2] ?? ""}`];
  return target ? NodePath.join(dir, target) : null;
}

const buildDefines = () => ({
  __OTTER_MAIL_VERSION__: JSON.stringify(vendoredVersion()),
  __GOOGLE_CLIENT_ID__: JSON.stringify(
    process.env.OTTER_MAIL_GOOGLE_CLIENT_ID?.trim() || PUBLIC_GOOGLE_CLIENT_ID,
  ),
  __GOOGLE_CLIENT_SECRET__: JSON.stringify(
    process.env.OTTER_MAIL_GOOGLE_CLIENT_SECRET?.trim() ?? "",
  ),
  __GOOGLE_LEGACY_CLIENT_ID__: JSON.stringify(
    process.env.OTTER_MAIL_GOOGLE_LEGACY_CLIENT_ID?.trim() ?? "",
  ),
  __GOOGLE_LEGACY_CLIENT_SECRET__: JSON.stringify(
    process.env.OTTER_MAIL_GOOGLE_LEGACY_CLIENT_SECRET?.trim() ?? "",
  ),
});

/** Only database drivers from auth adapters Mail's client never calls may stay external. */
export function isUnusedMailDatabaseDriver(source: string, importer: string | undefined): boolean {
  const file = importer?.replaceAll("\\", "/") ?? "";
  if (source === "pg" || source === "mysql2/promise") {
    return /\/node_modules\/(?:@better-auth\/kysely-adapter\/dist\/|better-auth\/dist\/db\/)/.test(
      file,
    );
  }
  if (source === "pg-native") {
    return file.endsWith("/node_modules/pg/lib/native/client.js");
  }
  if (source === "@prisma/client") {
    return file.includes("/node_modules/@better-auth/prisma-adapter/dist/");
  }
  if (source === "mongodb") {
    return file.includes("/node_modules/@better-auth/mongo-adapter/dist/");
  }
  return false;
}

export function mailWorkerBuildOnLog(
  level: "warn" | "info" | "debug",
  log: { readonly code?: string; readonly message: string },
  handler: (
    level: "error" | "warn" | "info" | "debug",
    log: { readonly code?: string; readonly message: string },
  ) => void,
): void {
  if (log.code === "UNRESOLVED_IMPORT") {
    handler("error", log);
    return;
  }
  if (log.code === "EVAL") return;
  handler(level, log);
}

/** Bundles the worker to `outFile`; answers the files it read, for the dev cache. */
export async function buildMailWorker(outFile: string): Promise<ReadonlyArray<string>> {
  const { Rolldown } = await import("vite-plus/pack");
  const bundle = await Rolldown.rolldown({
    input: NodePath.join(WORKER_DIR, "mailWorker.ts"),
    platform: "node",
    resolve: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
    transform: { define: buildDefines() },
    // Unknown missing imports must fail the build, rather than ship a broken worker.
    onLog: mailWorkerBuildOnLog,
    plugins: [
      {
        name: "otterware-mail-worker",
        resolveId(source, importer) {
          if (isUnusedMailDatabaseDriver(source, importer)) {
            return { id: source, external: true };
          }
          if (source.startsWith("otter-mail-desktop/")) {
            return NodePath.join(
              DESKTOP_SERVICES,
              `${source.slice("otter-mail-desktop/".length)}.ts`,
            );
          }
          if (importer?.startsWith(DESKTOP_SERVICES) && SHIMS[source]) return SHIMS[source];
          return resolveVendoredPackage(source);
        },
      },
    ],
  });
  try {
    await bundle.write({
      file: outFile,
      format: "esm",
      codeSplitting: false,
      sourcemap: true,
      // Some of Mail's dependencies are CommonJS and call require() for Node built-ins.
      banner:
        'import { createRequire as __otterwareCreateRequire } from "node:module";\nconst require = __otterwareCreateRequire(import.meta.url);',
    });
    return bundle.watchFiles;
  } finally {
    await bundle.close();
  }
}

type DevManifest = { readonly defines: string; readonly inputs: Record<string, number> };

function isFresh(manifestPath: string, outFile: string): boolean {
  if (!NodeFS.existsSync(outFile) || !NodeFS.existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as DevManifest;
    if (manifest.defines !== JSON.stringify(buildDefines())) return false;
    return Object.entries(manifest.inputs).every(
      ([file, mtime]) => NodeFS.existsSync(file) && NodeFS.statSync(file).mtimeMs === mtime,
    );
  } catch {
    return false;
  }
}

/** The dev server's worker bundle, rebuilt when Mail or the worker changed since the last build. */
export async function ensureDevMailWorker(cacheDir: string): Promise<string> {
  const outFile = NodePath.join(cacheDir, "otter-mail-worker.mjs");
  const manifestPath = NodePath.join(cacheDir, "inputs.json");
  if (isFresh(manifestPath, outFile)) return outFile;
  NodeFS.mkdirSync(cacheDir, { recursive: true });
  const inputs = (await buildMailWorker(outFile)).filter(
    (file) => NodePath.isAbsolute(file) && NodeFS.existsSync(file),
  );
  const manifest: DevManifest = {
    defines: JSON.stringify(buildDefines()),
    inputs: Object.fromEntries(inputs.map((file) => [file, NodeFS.statSync(file).mtimeMs])),
  };
  NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest));
  return outFile;
}

if (import.meta.main) {
  const outFile = NodePath.resolve(process.argv[2] ?? "dist/otter-mail-worker.mjs");
  const inputs = await buildMailWorker(outFile);
  console.log(`Built ${NodePath.relative(process.cwd(), outFile)} from ${inputs.length} files.`);
}
