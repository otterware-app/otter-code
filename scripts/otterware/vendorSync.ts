// @effect-diagnostics nodeBuiltinImport:off - plain Node: git and file copies, no Effect runtime.
/**
 * Vendoring for Otterware modules whose code lives in another repository (Otter Calendar, ...).
 *
 * A manifest (`scripts/otterware/vendor/<name>.json`) names the upstream repository, the pinned
 * commit and the paths copied from it. Files are copied byte for byte, then the manifest's
 * declared adaptations run, in this order:
 *
 * 1. `rewrites`: literal replacements in every text file (e.g. Effect's `effect/unstable/*`
 *    imports, which graduated to `effect/*` in the Effect version this repository uses).
 * 2. `importRemaps`: a relative import that resolves to `target` (from a file under `importer`)
 *    is pointed at `replacement`, an Otterware-owned module, instead.
 * 3. `patches`: unified diffs applied with `git apply`, for anything the two above cannot express.
 *
 * Everything else that adapts the vendored code lives in Otterware-owned files, never in the
 * vendored ones, so a re-sync is a plain copy. `check` proves the working tree still matches the
 * pinned commit after those adaptations.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface VendorPathEntry {
  /** Path in the upstream repository; a trailing `/` copies the whole directory. */
  readonly upstream: string;
  /** Where it lands here; defaults to the same path. */
  readonly local?: string;
}

export interface VendorRewrite {
  readonly from: string;
  readonly to: string;
  /** Local paths (or path prefixes) the rewrite is limited to; every file when absent. */
  readonly files?: ReadonlyArray<string>;
}

export interface VendorImportRemap {
  /** Only files whose local path starts with this prefix are rewritten. */
  readonly importer: string;
  /** Repository-relative module path without extension, e.g. `apps/web/src/state/server`. */
  readonly target: string;
  /** Repository-relative module path without extension. */
  readonly replacement: string;
}

export interface VendorManifest {
  readonly upstream: {
    readonly name: string;
    readonly repo: string;
    readonly ref: string;
    readonly commit: string;
  };
  readonly paths: ReadonlyArray<string | VendorPathEntry>;
  readonly exclude?: ReadonlyArray<string>;
  readonly rewrites?: ReadonlyArray<VendorRewrite>;
  readonly importRemaps?: ReadonlyArray<VendorImportRemap>;
  /** Patch files, relative to the manifest's directory. */
  readonly patches?: ReadonlyArray<string>;
  /**
   * Upstream files Otterware re-implements instead of vendoring (wiring, routes, RPC lists).
   * A sync lists which of them changed so the adaptation can follow.
   */
  readonly watch?: ReadonlyArray<string>;
  /** Generated: every vendored file's local path at `commit`. */
  readonly files?: ReadonlyArray<string>;
}

export interface VendoredFile {
  readonly upstreamPath: string;
  readonly localPath: string;
  readonly contents: Buffer;
}

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".css", ".md", ".json"]);
const MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);

const isText = (path: string) => TEXT_EXTENSIONS.has(NodePath.extname(path));

const normalizeEntry = (entry: string | VendorPathEntry): Required<VendorPathEntry> =>
  typeof entry === "string"
    ? { upstream: entry, local: entry }
    : { upstream: entry.upstream, local: entry.local ?? entry.upstream };

/** Maps upstream file paths to local ones for the manifest's `paths` and `exclude`. */
export function selectFiles(
  manifest: Pick<VendorManifest, "paths" | "exclude">,
  upstreamFiles: ReadonlyArray<string>,
): Array<{ upstreamPath: string; localPath: string }> {
  const excluded = new Set(manifest.exclude ?? []);
  const selected = new Map<string, string>();
  for (const rawEntry of manifest.paths) {
    const entry = normalizeEntry(rawEntry);
    if (entry.upstream.endsWith("/")) {
      const matches = upstreamFiles.filter((file) => file.startsWith(entry.upstream));
      if (matches.length === 0) throw new Error(`Upstream has no files under ${entry.upstream}`);
      for (const file of matches) {
        selected.set(file, entry.local + file.slice(entry.upstream.length));
      }
    } else {
      if (!upstreamFiles.includes(entry.upstream)) {
        throw new Error(`Upstream has no file ${entry.upstream}`);
      }
      selected.set(entry.upstream, entry.local);
    }
  }
  return [...selected]
    .filter(([upstreamPath]) => !excluded.has(upstreamPath))
    .map(([upstreamPath, localPath]) => ({ upstreamPath, localPath }))
    .toSorted((left, right) => left.localPath.localeCompare(right.localPath));
}

const stripModuleExtension = (path: string) => {
  const extension = NodePath.posix.extname(path);
  return MODULE_EXTENSIONS.has(extension) ? path.slice(0, -extension.length) : path;
};

const IMPORT_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\2/g;

/** Points relative imports of `localPath` at Otterware replacements. */
export function remapImports(
  localPath: string,
  source: string,
  remaps: ReadonlyArray<VendorImportRemap>,
): string {
  const applicable = remaps.filter((remap) => localPath.startsWith(remap.importer));
  if (applicable.length === 0) return source;
  const directory = NodePath.posix.dirname(localPath);
  return source.replace(IMPORT_SPECIFIER, (match, prefix: string, quote: string, specifier) => {
    if (!specifier.startsWith(".")) return match;
    const resolved = stripModuleExtension(NodePath.posix.normalize(`${directory}/${specifier}`));
    const remap = applicable.find((candidate) => candidate.target === resolved);
    if (remap === undefined) return match;
    let next = NodePath.posix.relative(directory, remap.replacement);
    if (!next.startsWith(".")) next = `./${next}`;
    const extension = NodePath.posix.extname(specifier);
    if (MODULE_EXTENSIONS.has(extension)) next += extension;
    return `${prefix}${quote}${next}${quote}`;
  });
}

/** Applies `rewrites` and `importRemaps` to one file. */
export function transformFile(
  manifest: Pick<VendorManifest, "rewrites" | "importRemaps">,
  localPath: string,
  contents: Buffer,
): Buffer {
  if (!isText(localPath)) return contents;
  let text = contents.toString("utf8");
  for (const rewrite of manifest.rewrites ?? []) {
    if (rewrite.files !== undefined && !rewrite.files.some((file) => localPath.startsWith(file))) {
      continue;
    }
    text = text.split(rewrite.from).join(rewrite.to);
  }
  text = remapImports(localPath, text, manifest.importRemaps ?? []);
  return Buffer.from(text, "utf8");
}

const git = (cwd: string, args: ReadonlyArray<string>, options: { input?: string } = {}) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    input: options.input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });

/** A bare clone under the user's cache that keeps fetched upstream commits between runs. */
export function upstreamCache(name: string): string {
  const base = process.env.XDG_CACHE_HOME ?? NodePath.join(NodeOS.homedir(), ".cache");
  const dir = NodePath.join(base, "otterware", "vendor", `${name}.git`);
  if (!NodeFS.existsSync(dir)) {
    NodeFS.mkdirSync(dir, { recursive: true });
    git(dir, ["init", "--bare", "--quiet"]);
  }
  return dir;
}

const hasCommit = (cache: string, commit: string) => {
  try {
    git(cache, ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/** Fetches `ref` (or makes sure `commit` is present) and returns the full commit id. */
export function fetchUpstream(
  cache: string,
  repo: string,
  target: { readonly ref?: string; readonly commit?: string },
): string {
  if (target.commit !== undefined && hasCommit(cache, target.commit)) {
    return git(cache, ["rev-parse", `${target.commit}^{commit}`])
      .toString()
      .trim();
  }
  if (target.commit !== undefined) {
    // Not every server serves a bare commit id; the branch usually still contains it.
    try {
      git(cache, ["fetch", "--quiet", "--no-tags", repo, target.commit]);
    } catch {
      git(cache, ["fetch", "--quiet", "--no-tags", repo, target.ref ?? "HEAD"]);
    }
    if (!hasCommit(cache, target.commit)) {
      throw new Error(`${repo} does not have commit ${target.commit}`);
    }
    return git(cache, ["rev-parse", `${target.commit}^{commit}`])
      .toString()
      .trim();
  }
  git(cache, ["fetch", "--quiet", "--no-tags", repo, target.ref ?? "HEAD"]);
  return git(cache, ["rev-parse", "FETCH_HEAD^{commit}"]).toString().trim();
}

/** Builds every vendored file as it should look here, patches included. */
export function buildVendoredTree(
  manifest: VendorManifest,
  manifestDir: string,
  cache: string,
  commit: string,
): ReadonlyArray<VendoredFile> {
  const upstreamFiles = git(cache, ["ls-tree", "-r", "--name-only", commit])
    .toString()
    .split("\n")
    .filter((line) => line.length > 0);
  const selected = selectFiles(manifest, upstreamFiles);
  const staging = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), `${manifest.upstream.name}-vendor-`),
  );
  try {
    for (const file of selected) {
      const raw = git(cache, ["show", `${commit}:${file.upstreamPath}`]);
      const target = NodePath.join(staging, file.localPath);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, transformFile(manifest, file.localPath, raw));
    }
    for (const patch of manifest.patches ?? []) {
      const patchPath = NodePath.resolve(manifestDir, patch);
      try {
        git(staging, ["apply", "--whitespace=nowarn", patchPath]);
      } catch (cause) {
        const stderr = (cause as { stderr?: Buffer }).stderr?.toString() ?? String(cause);
        throw new Error(
          `Patch ${patch} no longer applies to ${manifest.upstream.name}@${commit.slice(0, 10)}. Re-create it against the new upstream files.\n${stderr}`,
          { cause },
        );
      }
    }
    return selected.map((file) => ({
      ...file,
      contents: NodeFS.readFileSync(NodePath.join(staging, file.localPath)),
    }));
  } finally {
    NodeFS.rmSync(staging, { recursive: true, force: true });
  }
}

export interface VendorDrift {
  readonly changed: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
  /** Listed in the manifest's `files` but no longer produced by the pinned commit. */
  readonly stale: ReadonlyArray<string>;
}

export function compareWithWorkingTree(
  repoRoot: string,
  manifest: VendorManifest,
  expected: ReadonlyArray<VendoredFile>,
): VendorDrift {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const file of expected) {
    const path = NodePath.join(repoRoot, file.localPath);
    if (!NodeFS.existsSync(path)) missing.push(file.localPath);
    else if (!NodeFS.readFileSync(path).equals(file.contents)) changed.push(file.localPath);
  }
  const produced = new Set(expected.map((file) => file.localPath));
  const stale = (manifest.files ?? []).filter((file) => !produced.has(file));
  return { changed, missing, stale };
}

/** Writes the vendored files, removes ones upstream dropped, and returns the new manifest. */
export function writeVendoredTree(
  repoRoot: string,
  manifest: VendorManifest,
  commit: string,
  files: ReadonlyArray<VendoredFile>,
): { manifest: VendorManifest; written: string[]; removed: string[] } {
  const written: string[] = [];
  for (const file of files) {
    const path = NodePath.join(repoRoot, file.localPath);
    if (NodeFS.existsSync(path) && NodeFS.readFileSync(path).equals(file.contents)) continue;
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, file.contents);
    written.push(file.localPath);
  }
  const produced = new Set(files.map((file) => file.localPath));
  const removed = (manifest.files ?? []).filter((file) => !produced.has(file));
  for (const file of removed) NodeFS.rmSync(NodePath.join(repoRoot, file), { force: true });
  return {
    manifest: {
      ...manifest,
      upstream: { ...manifest.upstream, commit },
      files: files.map((file) => file.localPath),
    },
    written,
    removed,
  };
}

/** Upstream files on the watch list that changed between two commits. */
export function changedWatchedFiles(
  cache: string,
  manifest: VendorManifest,
  fromCommit: string,
  toCommit: string,
): string[] {
  if (fromCommit === toCommit || (manifest.watch ?? []).length === 0) return [];
  return git(cache, ["diff", "--name-only", fromCommit, toCommit, "--", ...(manifest.watch ?? [])])
    .toString()
    .split("\n")
    .filter((line) => line.length > 0);
}

/**
 * The manifest text after a sync: only `commit` and `files` change, so the rest keeps the
 * repository formatter's layout.
 */
export function updateManifestText(previous: string, manifest: VendorManifest): string {
  const files = (manifest.files ?? []).map((file) => `    ${JSON.stringify(file)}`).join(",\n");
  const filesBlock = `"files": [${files.length === 0 ? "" : `\n${files}\n  `}]`;
  const withCommit = previous.replace(
    /"commit": "[^"]*"/,
    `"commit": ${JSON.stringify(manifest.upstream.commit)}`,
  );
  // The top-level key, indented once (a rewrite's `files` sits deeper).
  const topLevelFiles = /\n {2}"files": \[[^\]]*\]/;
  return topLevelFiles.test(withCommit)
    ? withCommit.replace(topLevelFiles, `\n  ${filesBlock}`)
    : `${JSON.stringify(manifest, null, 2)}\n`;
}
