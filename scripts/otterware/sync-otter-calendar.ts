#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a plain Node CLI, like `vendorSync.ts`.
/**
 * Re-syncs the vendored Otter Calendar files from upstream (see `vendorSync.ts` and
 * `vendor/otter-calendar.json`).
 *
 *   node scripts/otterware/sync-otter-calendar.ts                 # latest upstream `main`
 *   node scripts/otterware/sync-otter-calendar.ts --ref <ref>     # a branch, tag or commit
 *   node scripts/otterware/sync-otter-calendar.ts --check         # verify against the pinned commit
 *
 * `--repo <url|path>` reads from another clone (e.g. a local checkout) instead of the manifest's.
 * A sync rewrites the manifest's `commit` and `files`, then lists the watched upstream files that
 * changed: those are the places Otterware re-implements (RPC list, wiring, routes) and may need
 * to follow by hand. Run the calendar typecheck and tests afterwards.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  buildVendoredTree,
  changedWatchedFiles,
  compareWithWorkingTree,
  fetchUpstream,
  upstreamCache,
  updateManifestText,
  type VendorManifest,
  writeVendoredTree,
} from "./vendorSync.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..", "..");
const manifestPath = NodePath.join(import.meta.dirname, "vendor", "otter-calendar.json");

function parseArgs(argv: ReadonlyArray<string>) {
  const options: { check: boolean; ref?: string; repo?: string } = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === "--check") options.check = true;
    else if (arg === "--ref") options.ref = value();
    else if (arg === "--repo") options.repo = value();
    else throw new Error(`Unknown argument ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestText = NodeFS.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as VendorManifest;
  const repo = options.repo ?? manifest.upstream.repo;
  const cache = upstreamCache(manifest.upstream.name);
  const manifestDir = NodePath.dirname(manifestPath);

  if (options.check) {
    const commit = fetchUpstream(cache, repo, {
      ref: manifest.upstream.ref,
      commit: manifest.upstream.commit,
    });
    const expected = buildVendoredTree(manifest, manifestDir, cache, commit);
    const drift = compareWithWorkingTree(repoRoot, manifest, expected);
    const problems = [
      ...drift.changed.map((file) => `changed  ${file}`),
      ...drift.missing.map((file) => `missing  ${file}`),
      ...drift.stale.map((file) => `stale    ${file} (manifest lists it, upstream does not)`),
    ];
    if (problems.length > 0) {
      console.error(
        `${problems.length} vendored file(s) differ from ${manifest.upstream.name}@${commit.slice(0, 10)}:\n  ${problems.join("\n  ")}\n` +
          "Vendored files must stay as upstream ships them; adapt in Otterware-owned files, or as a patch listed in the manifest.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `${expected.length} vendored file(s) match ${manifest.upstream.name}@${commit.slice(0, 10)}.`,
    );
    return;
  }

  const commit = fetchUpstream(
    cache,
    repo,
    options.ref === undefined ? { ref: manifest.upstream.ref } : { ref: options.ref },
  );
  // Make sure the previous commit is around for the watch-list diff.
  const previous = fetchUpstream(cache, repo, {
    ref: manifest.upstream.ref,
    commit: manifest.upstream.commit,
  });
  const files = buildVendoredTree(manifest, manifestDir, cache, commit);
  const result = writeVendoredTree(repoRoot, manifest, commit, files);
  NodeFS.writeFileSync(manifestPath, updateManifestText(manifestText, result.manifest));

  console.log(
    `${manifest.upstream.name}: ${previous.slice(0, 10)} -> ${commit.slice(0, 10)}; ${result.written.length} written, ${result.removed.length} removed, ${files.length} vendored.`,
  );
  for (const file of result.written) console.log(`  wrote   ${file}`);
  for (const file of result.removed) console.log(`  removed ${file}`);
  const watched = changedWatchedFiles(cache, manifest, previous, commit);
  if (watched.length > 0) {
    console.log(
      "\nWatched upstream files changed; check whether the Otterware adaptation needs to follow:",
    );
    for (const file of watched) console.log(`  ${file}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
