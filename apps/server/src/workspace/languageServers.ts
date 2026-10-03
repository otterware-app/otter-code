// @effect-diagnostics globalTimers:off -- Version probes own and clear their deadline.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type {
  CodeIntelligenceServerId,
  CodeIntelligenceSettings,
  LanguageServerStatus,
} from "@t3tools/contracts";
import { nodeScriptCommand } from "../nodeScript.ts";

export type LspServerId = Exclude<CodeIntelligenceServerId, "typescript" | "json">;

/** How each external language server is found, started, and described to the user. */
export const LSP_SERVERS = {
  python: {
    name: "Pyright",
    label: "Python",
    languageId: "python",
    defaultCommand: "pyright-langserver",
    envVar: "T3CODE_PYRIGHT_PATH",
    args: ["--stdio"],
    tabSize: 4,
    installHint: "Install it with npm install -g pyright.",
  },
  rust: {
    name: "rust-analyzer",
    label: "Rust",
    languageId: "rust",
    defaultCommand: "rust-analyzer",
    envVar: "T3CODE_RUST_ANALYZER_PATH",
    args: [],
    tabSize: 4,
    installHint:
      "With rustup, it installs automatically when you open a Rust file. Otherwise install rust-analyzer.",
  },
  protobuf: {
    name: "Buf",
    label: "Protobuf",
    languageId: "proto",
    defaultCommand: "buf",
    envVar: "T3CODE_BUF_PATH",
    args: ["lsp", "serve"],
    tabSize: 2,
    installHint:
      "Uses the workspace's @bufbuild/buf when installed. Otherwise install the Buf CLI from buf.build/docs/installation.",
  },
} satisfies Record<LspServerId, unknown>;

const BUNDLED = {
  typescript: { label: "TypeScript & JavaScript", languages: [".ts", ".tsx", ".js", ".jsx"] },
  json: { label: "JSON", languages: [".json", ".jsonc"] },
} as const;
const LANGUAGES: Record<LspServerId, ReadonlyArray<string>> = {
  python: [".py", ".pyi"],
  rust: [".rs"],
  protobuf: [".proto"],
};

export const isLanguageServerEnabled = (
  id: CodeIntelligenceServerId,
  settings: CodeIntelligenceSettings,
) => settings[id]?.enabled !== false;

export interface LanguageServerLaunch {
  command: string;
  args: ReadonlyArray<string>;
  /** Runs a JavaScript server shipped with T3 on T3's own Node (or Electron as Node). */
  builtIn: boolean;
}

function bundledPyright() {
  try {
    return NodeModule.createRequire(import.meta.url).resolve("pyright/langserver.index.js");
  } catch {
    return null;
  }
}

/**
 * Settings win over the legacy environment variable, which wins over the default. Python
 * defaults to the Pyright that ships with T3, so it works without installing anything.
 */
export function languageServerLaunch(
  id: LspServerId,
  settings: CodeIntelligenceSettings,
): LanguageServerLaunch {
  const server = LSP_SERVERS[id];
  const command = settings[id]?.command?.trim() || process.env[server.envVar]?.trim();
  if (command) return { command, args: server.args, builtIn: false };
  const script = id === "python" ? bundledPyright() : null;
  if (script) return { ...nodeScriptCommand(script, server.args), builtIn: true };
  return { command: server.defaultCommand, args: server.args, builtIn: false };
}

/**
 * Gets a missing default server ready for one workspace, the way the VS Code extensions do,
 * so opening a file just works. rust-analyzer and the standard-library sources come from the
 * workspace's rustup toolchain; Buf comes from the workspace's own node_modules.
 */
export async function prepareLanguageServerLaunch(
  id: LspServerId,
  launch: LanguageServerLaunch,
  root: string,
  file: string,
): Promise<LanguageServerLaunch> {
  if (launch.builtIn || launch.command !== LSP_SERVERS[id].defaultCommand) return launch;
  if (id === "rust") await ensureRustComponents(root);
  if (id === "protobuf" && !(await resolveCommand(launch.command))) {
    const local = await workspaceBinary(root, file, launch.command);
    if (local) return { ...launch, command: local };
  }
  return launch;
}

/** The nearest node_modules/.bin/<command> from the file's directory up to the workspace root. */
async function workspaceBinary(root: string, file: string, command: string) {
  for (let directory = NodePath.dirname(file); ; directory = NodePath.dirname(directory)) {
    const found = await resolveCommand(NodePath.join(directory, "node_modules", ".bin", command));
    if (found) return found;
    if (directory === root || NodePath.dirname(directory) === directory) return null;
  }
}

const isDirectory = (path: string) =>
  NodeFSP.stat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );

const rustInstalls = new Map<string, Promise<void>>();

/** Adds rust-analyzer and rust-src to the toolchain rustup picks for this workspace. */
function ensureRustComponents(root: string): Promise<void> {
  const running = rustInstalls.get(root);
  if (running) return running;
  const install = (async () => {
    if (!(await resolveCommand("rustup"))) return;
    const missing: string[] = [];
    if (!(await run("rustup", ["which", "rust-analyzer"], root, 10_000)).ok)
      missing.push("rust-analyzer");
    const sysroot = await run("rustc", ["--print", "sysroot"], root, 10_000);
    const sources = sysroot.ok
      ? NodePath.join(sysroot.output, "lib", "rustlib", "src", "rust", "library")
      : null;
    const hasSources = sources !== null && (await isDirectory(sources));
    if (!hasSources) missing.push("rust-src");
    if (missing.length === 0) return;
    const added = await run("rustup", ["component", "add", ...missing], root, 10 * 60_000);
    if (!added.ok)
      throw new Error(
        `Could not install ${missing.join(" and ")} with rustup: ${added.output} Run rustup component add ${missing.join(" ")} in the workspace, then Retry.`,
      );
  })();
  rustInstalls.set(root, install);
  // A success is remembered for the server's lifetime; a failure is retried on the next open.
  install.catch(() => rustInstalls.delete(root));
  return install;
}

/** Trimmed stdout when the command succeeds in time, otherwise the tail of its stderr. */
function run(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  timeout: number,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { cwd, timeout, windowsHide: true },
      (error, stdout, stderr) =>
        resolve(
          error
            ? { ok: false, output: (stderr.trim() || error.message).slice(-500) }
            : { ok: true, output: stdout.trim() },
        ),
    );
  });
}

/** Identifies a launch, so a session restarts when Settings change what would run. */
export const launchKey = (launch: LanguageServerLaunch) =>
  [launch.command, ...launch.args].join("\0");

async function resolveCommand(command: string): Promise<string | null> {
  const executable = async (path: string) =>
    NodeFSP.access(path, NodeFSP.constants.X_OK).then(
      () => path,
      () => null,
    );
  if (command.includes("/") || command.includes("\\")) return executable(command);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- language backends run outside the Effect runtime.
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of (process.env.PATH ?? "").split(NodePath.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const found = await executable(NodePath.join(directory, command + extension));
      if (found) return found;
    }
  }
  return null;
}

function firstLine(command: string, args: ReadonlyArray<string>): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, 5_000);
    timer.unref();
    const child = NodeChildProcess.execFile(
      command,
      [...args],
      { windowsHide: true },
      (error, stdout) =>
        done(error ? null : (stdout.trim().split("\n")[0]?.trim() ?? null) || null),
    );
  });
}

async function lspVersion(id: LspServerId, path: string): Promise<string | null> {
  // pyright-langserver has no --version; its sibling CLI ships in the same package.
  if (id === "python") {
    const cli = NodePath.join(NodePath.dirname(path), "pyright");
    return (await resolveCommand(cli)) ? firstLine(cli, ["--version"]) : null;
  }
  return firstLine(path, ["--version"]);
}

function bundledVersion(packageName: string) {
  try {
    const require = NodeModule.createRequire(import.meta.url);
    const manifest = require(`${packageName}/package.json`) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/** What Settings shows for each server on this environment. */
export async function languageServerStatuses(
  settings: CodeIntelligenceSettings,
): Promise<LanguageServerStatus[]> {
  const bundled = (["typescript", "json"] as const).map((id) => ({
    id,
    label: BUNDLED[id].label,
    languages: BUNDLED[id].languages,
    bundled: true,
    enabled: isLanguageServerEnabled(id, settings),
    command: null,
    path: null,
    version: bundledVersion(
      id === "typescript" ? "typescript-tsserver" : "vscode-json-languageservice",
    ),
    installHint: null,
  }));
  const external = await Promise.all(
    (Object.keys(LSP_SERVERS) as LspServerId[]).map(async (id) => {
      const launch = languageServerLaunch(id, settings);
      const base = {
        id,
        label: `${LSP_SERVERS[id].label} (${LSP_SERVERS[id].name})`,
        languages: LANGUAGES[id],
        enabled: isLanguageServerEnabled(id, settings),
        installHint: LSP_SERVERS[id].installHint,
      };
      if (launch.builtIn)
        return {
          ...base,
          bundled: true,
          command: null,
          path: null,
          version: bundledVersion("pyright"),
        };
      const path = await resolveCommand(launch.command);
      return {
        ...base,
        bundled: false,
        command: launch.command,
        path,
        version: path ? await lspVersion(id, path) : null,
      };
    }),
  );
  return [...bundled, ...external];
}
