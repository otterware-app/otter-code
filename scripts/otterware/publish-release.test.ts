// @effect-diagnostics nodeBuiltinImport:off -- Exercises publication with a fake gh transport only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

describe("Otterware release publication", () => {
  it.each(["new", "upgrade", "stale", "immutable-exists"])(
    "%s keeps immutable downloads and only advances its branch feed",
    async (scenario) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "otterware-publish-"));
      const bin = NodePath.join(root, "bin");
      const assets = NodePath.join(root, "assets");
      const feed = NodePath.join(root, "feed");
      const version = "1.2.3-otterware.20261012.5";
      try {
        await NodeFSP.mkdir(bin);
        await NodeFSP.mkdir(assets);
        await NodeFSP.mkdir(feed);
        await NodeFSP.writeFile(
          NodePath.join(assets, "latest-mac.yml"),
          `version: ${version}\nfiles:\n  - url: Otterware-${version}-arm64.zip\n    sha512: abc\npath: Otterware-${version}-arm64.zip\nreleaseDate: '2026-10-12'\n`,
        );
        await NodeFSP.writeFile(
          NodePath.join(assets, `Otterware-${version}-arm64.zip`),
          "fixture zip",
        );
        await NodeFSP.writeFile(
          NodePath.join(assets, `t3-${version}-linux-x64.tar.gz`),
          "fixture runtime",
        );
        await NodeFSP.writeFile(
          NodePath.join(assets, "SHA256SUMS"),
          `abc  t3-${version}-linux-x64.tar.gz\n`,
        );
        await NodeFSP.writeFile(
          NodePath.join(bin, "gh"),
          `#!/usr/bin/env python3
import os,sys,json,shutil
from pathlib import Path
args=sys.argv[1:]; root=Path(os.environ['OW_FIXTURE_ROOT']); scenario=os.environ['OW_FIXTURE_SCENARIO']
with (root/'calls').open('a') as log: log.write(json.dumps(args)+'\\n')
assert args[args.index('--repo')+1] == 'otterware-app/otterware-releases'
command=args[1]; tag=args[2]
if command=='view':
    if scenario=='new': sys.exit(1)
    if '--json' in args: print('old.zip\\nlatest-linux.yml')
elif command=='create':
    assert '--draft' not in args
    assert '--prerelease' in args
    if scenario=='immutable-exists' and tag.startswith('otterware-v'): sys.exit(1)
elif command=='download':
    previous='1.2.3-otterware.20261012.'+('9' if scenario=='stale' else '4')
    Path(args[args.index('--dir')+1], 'SHA256SUMS').write_text('abc  t3-'+previous+'-linux-x64.tar.gz\\n')
elif command=='upload':
    for file in args[3:args.index('--repo')]: shutil.copyfile(file, root/'feed'/Path(file).name)
`,
          { mode: 0o755 },
        );
        const script = NodeURL.fileURLToPath(new URL("./publish-release.sh", import.meta.url));
        const result = NodeChildProcess.spawnSync("bash", [script, assets], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            OW_FIXTURE_ROOT: root,
            OW_FIXTURE_SCENARIO: scenario,
            VERSION: version,
            CHANNEL: "feature-mail",
            SOURCE_SHA: "abc123",
            GITHUB_REPOSITORY: "otterware-app/otter-code",
            GITHUB_SERVER_URL: "https://github.com",
            GITHUB_RUN_ID: "123",
          },
        });
        expect(result.status, result.stderr).toBe(scenario === "immutable-exists" ? 1 : 0);
        const calls: string[][] = (await NodeFSP.readFile(NodePath.join(root, "calls"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const uploads = calls.filter((args) => args[1] === "upload");
        if (scenario === "stale" || scenario === "immutable-exists") {
          expect(uploads).toHaveLength(0);
        } else {
          const manifest = await NodeFSP.readFile(NodePath.join(feed, "latest-mac.yml"), "utf8");
          expect(manifest).toContain(
            `  - url: https://github.com/otterware-app/otterware-releases/releases/download/otterware-v${version}/Otterware-${version}-arm64.zip\n    sha512: abc\n`,
          );
          expect(manifest).toContain(
            `path: https://github.com/otterware-app/otterware-releases/releases/download/otterware-v${version}/`,
          );
          expect(uploads.at(-1)?.[3]).toMatch(/latest-mac.yml$/);
          const sums = await NodeFSP.readFile(NodePath.join(feed, "SHA256SUMS"), "utf8");
          const actual = NodeChildProcess.execFileSync(
            "sha256sum",
            [NodePath.join(feed, "latest-mac.yml")],
            { encoding: "utf8" },
          ).split(" ")[0];
          expect(sums).toContain(`${actual}  latest-mac.yml`);
          expect(
            calls.some((args) => args[1] === "delete-asset" && args[3] === "latest-linux.yml"),
          ).toBe(false);
        }
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});
