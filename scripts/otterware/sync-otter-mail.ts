#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off -- A plain Node maintenance script, run outside any Effect runtime.
/**
 * Re-vendors Otter Mail into `vendor/otter-mail/`, verbatim and at its own
 * relative paths, from an upstream commit. Otterware never edits those files:
 * everything Otterware-specific lives in its adapters (apps/server/src/suite/mail,
 * apps/web/src/suite/mail), so this script can run daily.
 *
 *   node scripts/otterware/sync-otter-mail.ts [--repo <path|git url>] [--ref <ref>]
 *     [--fetch] [--check] [--accept-contract]
 *
 * --repo   a local checkout (default $OTTER_MAIL_REPO, else the GitHub repo,
 *          cached in ~/.cache/otterware/otter-mail.git)
 * --ref    the commit to vendor (default: the checkout's HEAD, or origin/main)
 * --fetch  fetch the local checkout's origin first
 * --check  change nothing; exit 1 when vendor/ differs from the ref or a guard fails
 * --accept-contract  record the upstream contract as reviewed (after updating the adapters)
 *
 * Guards fail the sync, and leave vendor/ untouched, when upstream changes
 * what the adapters implement or call: the Platform/GoogleAuth/ToolCaller and
 * DesktopBridge/BridgeFeatures shapes, the exports the adapters import, the
 * relative imports the desktop services make (each needs a shim), or a
 * renderer channel that neither core nor the Otterware frame answers.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const ROOT = NodePath.resolve(import.meta.dirname, "../..");
const VENDOR = NodePath.join(ROOT, "vendor/otter-mail");
const CONTRACT_FILE = NodePath.join(import.meta.dirname, "otter-mail-contract.json");
const DEFAULT_REPO = "https://github.com/otterware-app/otter-mail.git";

/** Upstream paths vendored verbatim; directories recurse. */
export const ALLOWLIST = [
  "tsconfig.base.json",
  "packages/core/src",
  "packages/core/tsconfig.json",
  "packages/contracts/src",
  "packages/contracts/tsconfig.json",
  "packages/shared/src",
  "packages/shared/tsconfig.json",
  "apps/web/src/main",
  "apps/web/src/components",
  "apps/web/src/lib",
  "apps/web/src/styles.css",
  "apps/web/src/desktop-bridge.d.ts",
  "apps/web/src/vite-env.d.ts",
  "apps/web/src/web/demo",
  "apps/web/tsconfig.json",
  "apps/desktop/src/services/gmail-oauth.ts",
  "apps/desktop/src/services/microsoft-oauth.ts",
  "apps/desktop/src/services/credentials-store.ts",
  "apps/desktop/src/services/mail-socket.ts",
  "apps/desktop/src/services/todoist-oauth.ts",
] as const;

/** Tests and their helpers stay upstream. */
export function isVendoredPath(relative: string): boolean {
  if (!ALLOWLIST.some((entry) => relative === entry || relative.startsWith(`${entry}/`))) {
    return false;
  }
  return (
    !/(^|\/)(test|__tests__|__screenshots__)\//.test(relative) && !/\.test\.tsx?$/.test(relative)
  );
}

/** The packages Otterware installs as workspace packages, with a manifest generated here. */
const PACKAGES = ["packages/core", "packages/contracts", "packages/shared", "apps/web"] as const;

/** Renderer dependencies only the browser's Web Worker backend uses (not vendored). */
const WORKER_ONLY_DEPENDENCIES = new Set(["@sqlite.org/sqlite-wasm", "subtls"]);
/** Dev dependencies the vendored renderer needs at build time (styles.css imports Inter). */
const RENDERER_BUILD_DEPENDENCIES = ["@fontsource-variable/inter"];

/** Exports the Otterware adapters import, per vendored file. */
export const REQUIRED_EXPORTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "packages/core/src/index.ts": [
    "startCore",
    "registeredHandlers",
    "handle",
    "agentTools",
    "runAgentTool",
    "addDemoMailboxes",
    "syncAllAccounts",
    "accountStore",
    "mailStore",
    "logger",
    "SignInCancelledError",
  ],
  "packages/core/src/services/agent/instructions.ts": ["TOOL_INSTRUCTIONS"],
  "packages/core/src/services/agent/tools/calendar.ts": ["calendarTools"],
  "packages/core/src/services/agent/tools/themes.ts": ["themeTools"],
  "apps/web/src/web/demo/gmail.ts": ["installFakeGmail", "demoGoogleAuth", "DEMO_RELAY_URL"],
  "apps/web/src/main/index.tsx": [],
  "apps/web/src/main/settings/settings-search.ts": ["SETTINGS_SECTION_LABELS"],
  "apps/desktop/src/services/gmail-oauth.ts": ["googleAuth"],
  "apps/desktop/src/services/microsoft-oauth.ts": ["microsoftAuth"],
  "apps/desktop/src/services/mail-socket.ts": ["connectMailSocket"],
  "apps/desktop/src/services/todoist-oauth.ts": ["todoistSignIn"],
};

/** Relative imports the vendored desktop services may make; anything else needs a new shim. */
const DESKTOP_RELATIVE_IMPORTS = new Set([
  "../main-link.js",
  "../backend-protocol.js",
  "./credentials-store.js",
]);

/** Declarations whose shape the adapters implement or call (normalized text is recorded). */
const CONTRACT_DECLARATIONS = [
  ["packages/core/src/platform.ts", "interface", "Platform"],
  ["packages/core/src/platform.ts", "interface", "GoogleAuth"],
  ["packages/core/src/platform.ts", "interface", "MicrosoftAuth"],
  ["packages/core/src/platform.ts", "interface", "SqlDatabase"],
  ["packages/core/src/platform.ts", "interface", "SqlStatement"],
  ["packages/core/src/platform.ts", "interface", "ByteStream"],
  ["packages/core/src/services/agent/tools/tool.ts", "type", "ToolCaller"],
  ["packages/core/src/services/agent/tools/tool.ts", "type", "AgentTool"],
  ["packages/contracts/src/index.ts", "interface", "DesktopBridge"],
  ["packages/contracts/src/index.ts", "interface", "BridgeFeatures"],
  ["packages/contracts/src/index.ts", "interface", "NativeThemeInfo"],
  ["apps/desktop/src/backend-protocol.ts", "type", "MainRequests"],
  ["apps/desktop/src/backend-protocol.ts", "type", "AppInfo"],
] as const;

/** Files outside the allowlist the guards read (shims replace them, so their shape matters). */
const GUARD_ONLY_FILES = ["apps/desktop/src/backend-protocol.ts"];

/** Where the Otterware side answers the renderer's channels that core has no handler for. */
const FRAME_CHANNELS_FILE = NodePath.join(ROOT, "apps/web/src/suite/mail/frame/frameChannels.ts");
const WORKER_DIR = NodePath.join(ROOT, "apps/server/src/suite/mail/worker");

interface Options {
  readonly repo: string;
  readonly ref: string | null;
  readonly fetch: boolean;
  readonly check: boolean;
  readonly acceptContract: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Options {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };
  return {
    repo: value("--repo") ?? process.env.OTTER_MAIL_REPO?.trim() ?? DEFAULT_REPO,
    ref: value("--ref"),
    fetch: argv.includes("--fetch"),
    check: argv.includes("--check"),
    acceptContract: argv.includes("--accept-contract"),
  };
}

function git(args: ReadonlyArray<string>, options: { cwd?: string; input?: Buffer } = {}): Buffer {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: options.cwd,
    input: options.input,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

/** A git dir holding the upstream commits, and the commit to vendor. */
function resolveSource(options: Options): { gitDir: string; sha: string } {
  const local = NodeFS.existsSync(options.repo) && NodeFS.statSync(options.repo).isDirectory();
  if (local) {
    const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd: options.repo })
      .toString()
      .trim();
    if (options.fetch) git(["--git-dir", gitDir, "fetch", "--quiet", "origin"]);
    const sha = git(["--git-dir", gitDir, "rev-parse", `${options.ref ?? "HEAD"}^{commit}`])
      .toString()
      .trim();
    return { gitDir, sha };
  }
  const gitDir = NodePath.join(NodeOS.homedir(), ".cache/otterware/otter-mail.git");
  if (!NodeFS.existsSync(gitDir)) {
    NodeFS.mkdirSync(NodePath.dirname(gitDir), { recursive: true });
    git(["clone", "--quiet", "--bare", options.repo, gitDir]);
  } else {
    git([
      "--git-dir",
      gitDir,
      "fetch",
      "--quiet",
      "--prune",
      options.repo,
      "+refs/heads/*:refs/heads/*",
    ]);
  }
  const sha = git(["--git-dir", gitDir, "rev-parse", `${options.ref ?? "main"}^{commit}`])
    .toString()
    .trim();
  return { gitDir, sha };
}

/** Every vendored file at `sha`, by upstream-relative path, plus the guard-only files. */
function readUpstream(gitDir: string, sha: string) {
  const listed = git(["--git-dir", gitDir, "ls-tree", "-r", "-z", "--name-only", sha])
    .toString()
    .split("\0")
    .filter((entry) => entry.length > 0);
  const read = (relative: string) => git(["--git-dir", gitDir, "show", `${sha}:${relative}`]);
  const files = new Map<string, Buffer>();
  for (const relative of listed) if (isVendoredPath(relative)) files.set(relative, read(relative));
  const extra = new Map<string, string>();
  for (const relative of [...GUARD_ONLY_FILES, ...PACKAGES.map((p) => `${p}/package.json`)]) {
    extra.set(relative, read(relative).toString());
  }
  return { files, extra };
}

// ── Manifests ────────────────────────────────────────────────────────────────

type Manifest = {
  name: string;
  version?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** The root web app's React, which the frame shares (Vite dedupes it). */
function otterCodeReactVersions(): Record<string, string> {
  const web = JSON.parse(
    NodeFS.readFileSync(NodePath.join(ROOT, "apps/web/package.json"), "utf8"),
  ) as Manifest;
  const pick = (name: string) => web.dependencies?.[name] ?? web.devDependencies?.[name];
  return Object.fromEntries(
    ["react", "react-dom", "@types/react", "@types/react-dom"].flatMap((name) => {
      const version = pick(name);
      return version ? [[name, version]] : [];
    }),
  );
}

/**
 * The workspace manifest Otterware installs for a vendored package: upstream's
 * name, exports and runtime dependencies (React pinned to Otter Code's), no
 * scripts, so repo-wide runs never build or test vendored code.
 */
export function generateManifest(
  relativeDir: string,
  upstream: Manifest,
  react: Record<string, string>,
) {
  const dependencies: Record<string, string> = {};
  for (const [name, version] of Object.entries(upstream.dependencies ?? {})) {
    if (relativeDir === "apps/web" && WORKER_ONLY_DEPENDENCIES.has(name)) continue;
    dependencies[name] = react[name] ?? version;
  }
  if (relativeDir === "apps/web") {
    for (const name of RENDERER_BUILD_DEPENDENCIES) {
      const version = upstream.devDependencies?.[name];
      if (version) dependencies[name] = version;
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(dependencies).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  return `${JSON.stringify(
    {
      name: upstream.name,
      version: upstream.version ?? "0.0.0",
      private: true,
      description: "Vendored from Otter Mail by scripts/otterware/sync-otter-mail.ts. Do not edit.",
      type: "module",
      ...(upstream.exports === undefined ? {} : { exports: upstream.exports }),
      ...(Object.keys(sorted).length === 0 ? {} : { dependencies: sorted }),
    },
    null,
    2,
  )}\n`;
}

// ── Guards ───────────────────────────────────────────────────────────────────

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** The text of `export interface Name {...}` / `export type Name = ...;`, comments and spacing normalized. */
export function extractDeclaration(
  source: string,
  kind: "interface" | "type",
  name: string,
): string | null {
  const code = stripComments(source);
  const start = code.search(new RegExp(`export\\s+${kind}\\s+${name}\\b`));
  if (start === -1) return null;
  let index = code.indexOf(kind === "interface" ? "{" : "=", start);
  if (index === -1) return null;
  let depth = 0;
  for (; index < code.length; index++) {
    const char = code[index];
    if (char === "{" || char === "(" || char === "<" || char === "[") depth++;
    else if (char === "}" || char === ")" || char === ">" || char === "]") {
      // `=>` is not a closing bracket.
      if (char === ">" && code[index - 1] === "=") continue;
      depth--;
      if (kind === "interface" && depth === 0) break;
    } else if (kind === "type" && char === ";" && depth === 0) break;
  }
  return code
    .slice(start, index + 1)
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether `source` exports `name` (declared or re-exported). */
export function hasExport(source: string, name: string): boolean {
  const code = stripComments(source);
  const declared = new RegExp(
    `export\\s+(async\\s+)?(function\\*?|const|let|class|interface|type|enum)\\s+${name}\\b`,
  );
  if (declared.test(code)) return true;
  if (new RegExp(`export\\s+\\*\\s+as\\s+${name}\\b`).test(code)) return true;
  for (const match of code.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    const names = (match[2] ?? "").split(",").map((entry) =>
      entry
        .trim()
        .split(/\s+as\s+/)
        .at(-1)
        ?.replace(/^type\s+/, ""),
    );
    if (names.includes(name)) return true;
  }
  return false;
}

/** Channels the renderer invokes by literal name (`ipc("gmail:x")`, `desktopBridge.invoke("x:y")`). */
export function rendererInvokeChannels(sources: Iterable<string>): Set<string> {
  const channels = new Set<string>();
  const pattern = /\b(?:invoke|ipc|call)\w*(?:<[^()]*?>)?\(\s*["']([a-zA-Z]+:[a-zA-Z][\w-]*)["']/g;
  for (const source of sources)
    for (const match of source.matchAll(pattern)) channels.add(match[1]!);
  return channels;
}

/** Channels registered with core's `handle("x:y", ...)`. */
export function handledChannels(sources: Iterable<string>): Set<string> {
  const channels = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/\bhandle\(\s*["']([a-zA-Z]+:[a-zA-Z][\w-]*)["']/g)) {
      channels.add(match[1]!);
    }
  }
  return channels;
}

type Contract = { upstream: string; declarations: Record<string, string> };

export async function runGuards(
  files: ReadonlyMap<string, Buffer>,
  extra: ReadonlyMap<string, string>,
  sha: string,
  acceptContract: boolean,
): Promise<{ failures: string[]; contract: Contract }> {
  const failures: string[] = [];
  const text = (relative: string) => files.get(relative)?.toString() ?? extra.get(relative) ?? null;

  for (const [relative, names] of Object.entries(REQUIRED_EXPORTS)) {
    const source = text(relative);
    if (source === null) {
      failures.push(`${relative} is gone upstream; an Otterware adapter imports it.`);
      continue;
    }
    const missing = names.filter((name) => !hasExport(source, name));
    if (missing.length > 0) failures.push(`${relative} no longer exports ${missing.join(", ")}.`);
  }

  for (const [relative] of files) {
    if (!relative.startsWith("apps/desktop/src/services/")) continue;
    const source = files.get(relative)!.toString();
    for (const match of source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      if (!DESKTOP_RELATIVE_IMPORTS.has(match[1]!)) {
        failures.push(
          `${relative} now imports ${match[1]}: add a shim for it in apps/server/src/suite/mail/worker.`,
        );
      }
    }
  }

  const declarations: Record<string, string> = {};
  for (const [relative, kind, name] of CONTRACT_DECLARATIONS) {
    const source = text(relative);
    const declaration = source === null ? null : extractDeclaration(source, kind, name);
    if (declaration === null) failures.push(`${relative} no longer declares ${kind} ${name}.`);
    else declarations[`${relative}#${name}`] = declaration;
  }
  const recorded: Contract | null = NodeFS.existsSync(CONTRACT_FILE)
    ? (JSON.parse(NodeFS.readFileSync(CONTRACT_FILE, "utf8")) as Contract)
    : null;
  if (!acceptContract) {
    for (const [key, declaration] of Object.entries(declarations)) {
      const before = recorded?.declarations[key];
      if (before !== declaration) {
        failures.push(
          `${key} changed upstream (recorded at ${recorded?.upstream ?? "nothing"}). Update the adapter, then rerun with --accept-contract.\n    before: ${before ?? "(none)"}\n    after:  ${declaration}`,
        );
      }
    }
  }

  const rendererSources = [...files]
    .filter(([relative]) => /^apps\/web\/src\/(main|components|lib)\/.*\.tsx?$/.test(relative))
    .map(([, bytes]) => bytes.toString());
  const coreSources = [...files]
    .filter(([relative]) => /^packages\/core\/src\/.*\.ts$/.test(relative))
    .map(([, bytes]) => bytes.toString());
  const workerSources = NodeFS.existsSync(WORKER_DIR)
    ? NodeFS.readdirSync(WORKER_DIR)
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .map((name) => NodeFS.readFileSync(NodePath.join(WORKER_DIR, name), "utf8"))
    : [];
  const handled = handledChannels([...coreSources, ...workerSources]);
  const frame = (await import(FRAME_CHANNELS_FILE)) as {
    isFrameChannel: (channel: string) => boolean;
  };
  const unanswered = [...rendererInvokeChannels(rendererSources)].filter(
    (channel) => !handled.has(channel) && !frame.isFrameChannel(channel),
  );
  if (unanswered.length > 0) {
    failures.push(
      `The renderer invokes channels nobody answers in Otterware: ${unanswered.toSorted().join(", ")}. Answer or stub them in apps/web/src/suite/mail/frame/frameChannels.ts.`,
    );
  }

  return { failures, contract: { upstream: sha, declarations } };
}

// ── Vendor tree ──────────────────────────────────────────────────────────────

function listVendored(): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string) => {
    if (!NodeFS.existsSync(dir)) return;
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else {
        out.set(
          NodePath.relative(VENDOR, full).split(NodePath.sep).join("/"),
          NodeFS.readFileSync(full),
        );
      }
    }
  };
  walk(VENDOR);
  return out;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { gitDir, sha } = resolveSource(options);
  const { files, extra } = readUpstream(gitDir, sha);

  const react = otterCodeReactVersions();
  const desired = new Map(files);
  for (const dir of PACKAGES) {
    const upstream = JSON.parse(extra.get(`${dir}/package.json`)!) as Manifest;
    desired.set(`${dir}/package.json`, Buffer.from(generateManifest(dir, upstream, react)));
  }
  desired.set("UPSTREAM", Buffer.from(`${sha}\n`));

  const { failures, contract } = await runGuards(files, extra, sha, options.acceptContract);

  const current = listVendored();
  const changed = [...desired].filter(([relative, bytes]) => !current.get(relative)?.equals(bytes));
  const removed = [...current.keys()].filter((relative) => !desired.has(relative));
  const manifestsChanged = changed.some(([relative]) => relative.endsWith("package.json"));

  console.log(
    `otter-mail ${sha.slice(0, 12)}: ${changed.length} file(s) to write, ${removed.length} to remove.`,
  );
  for (const failure of failures) console.error(`✗ ${failure}`);

  if (options.check) {
    for (const [relative] of changed) console.log(`  differs: ${relative}`);
    for (const relative of removed) console.log(`  stale:   ${relative}`);
    process.exitCode = failures.length > 0 || changed.length > 0 || removed.length > 0 ? 1 : 0;
    return;
  }
  if (failures.length > 0) {
    console.error("Sync stopped: vendor/otter-mail is unchanged.");
    process.exitCode = 1;
    return;
  }
  for (const [relative, bytes] of changed) {
    const target = NodePath.join(VENDOR, relative);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, bytes);
  }
  for (const relative of removed) NodeFS.rmSync(NodePath.join(VENDOR, relative));
  if (options.acceptContract || !NodeFS.existsSync(CONTRACT_FILE)) {
    NodeFS.writeFileSync(CONTRACT_FILE, `${JSON.stringify(contract, null, 2)}\n`);
  }
  if (manifestsChanged) {
    console.log(
      "Vendored dependencies changed: run `vp i` and commit pnpm-lock.yaml with the sync.",
    );
  }
}

if (import.meta.main) await main();
