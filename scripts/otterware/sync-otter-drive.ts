/**
 * Vendors Otter Drive's wire contracts (`@otterware/contracts`, private and
 * source-only upstream) into `vendor/otter-drive/`, so the Drive module's API
 * client is typed by the exact Zod schemas Drive validates with.
 *
 *   node scripts/otterware/sync-otter-drive.ts [--source <otter-drive checkout>]
 *   node scripts/otterware/sync-otter-drive.ts --check [--source <checkout>]
 *
 * Sync copies the files listed in FILES verbatim from the checkout's HEAD
 * (default `$OTTER_DRIVE_REPO` or `~/projects/otter-drive`) and rewrites
 * `vendor/otter-drive/manifest.json` with the commit and each file's hash.
 * `--check` fails when a vendored file no longer matches the manifest (it was
 * edited by hand) and, with a checkout available, when the checkout's HEAD has
 * different contracts than the ones vendored.
 *
 * The vendored package.json is ours, not upstream's: it renames the package to
 * `@otterware/drive-contracts`, keeps only the `zod` dependency (as a range
 * from upstream's pin, so the workspace shares one zod) and drops upstream's
 * scripts and devDependencies.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VENDOR_ROOT = join(REPO_ROOT, "vendor/otter-drive");
const MANIFEST_PATH = join(VENDOR_ROOT, "manifest.json");
const UPSTREAM = "https://github.com/otterware-app/otter-drive";
/** Upstream paths, vendored at the same relative path under `vendor/otter-drive/`. */
const FILES = ["packages/contracts/src/index.ts"] as const;

interface Manifest {
  readonly upstream: string;
  readonly commit: string;
  readonly syncedAt: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
  readonly notes: ReadonlyArray<string>;
}

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sourceCheckout(): string | null {
  const source = resolve(
    argValue("--source") ??
      process.env.OTTER_DRIVE_REPO ??
      join(homedir(), "projects", "otter-drive"),
  );
  return existsSync(join(source, ".git")) ? source : null;
}

function git(source: string, ...args: string[]): string {
  return execFileSync("git", ["-C", source, ...args], { encoding: "utf8" });
}

/** The file as committed at HEAD, so uncommitted local edits in the checkout never leak in. */
function readUpstream(source: string, path: string): string {
  return git(source, "show", `HEAD:${path}`);
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

function check(): number {
  const manifest = readManifest();
  const problems: string[] = [];
  for (const file of manifest.files) {
    const vendored = join(VENDOR_ROOT, file.path);
    if (!existsSync(vendored)) problems.push(`${file.path} is missing.`);
    else if (sha256(readFileSync(vendored)) !== file.sha256)
      problems.push(`${file.path} was changed after vendoring; re-run the sync instead.`);
  }
  const source = sourceCheckout();
  if (source === null) {
    console.log("No Otter Drive checkout found; checked the vendored files only.");
  } else {
    const head = git(source, "rev-parse", "HEAD").trim();
    for (const path of FILES) {
      if (
        sha256(readUpstream(source, path)) !== manifest.files.find((f) => f.path === path)?.sha256
      )
        problems.push(`${path} differs from Otter Drive ${head.slice(0, 7)}; run the sync.`);
    }
  }
  for (const problem of problems) console.error(problem);
  if (problems.length === 0)
    console.log(`Otter Drive contracts match ${manifest.commit.slice(0, 7)}.`);
  return problems.length === 0 ? 0 : 1;
}

function sync(): number {
  const source = sourceCheckout();
  if (source === null) {
    console.error("Pass --source <otter-drive checkout> or set OTTER_DRIVE_REPO.");
    return 1;
  }
  const commit = git(source, "rev-parse", "HEAD").trim();
  const files = FILES.map((path) => {
    const content = readUpstream(source, path);
    const target = join(VENDOR_ROOT, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return { path, sha256: sha256(content) };
  });
  const manifest: Manifest = {
    upstream: UPSTREAM,
    commit,
    syncedAt: new Date().toISOString(),
    files,
    notes: [
      "Files are verbatim copies of the upstream commit; edit them only through this sync.",
      "packages/contracts/package.json is Otterware's own: renamed to @otterware/drive-contracts, zod as ^4.4.3 (upstream pins 4.4.3; the range shares the workspace's zod), upstream scripts and devDependencies dropped.",
    ],
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Vendored Otter Drive contracts from ${commit.slice(0, 7)}.`);
  return 0;
}

process.exitCode = process.argv.includes("--check") ? check() : sync();
