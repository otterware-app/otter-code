import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone native build targets the actual host.
const hostPlatform = NodeOS.platform();
// oxlint-disable-next-line t3code/no-global-process-runtime -- The compiler needs the host architecture as its default.
const hostArch = NodeOS.arch();
const { values } = NodeUtil.parseArgs({
  options: { output: { type: "string" }, arch: { type: "string", default: hostArch } },
});

if (hostPlatform === "darwin") {
  const architectures = { arm64: ["arm64"], x64: ["x86_64"], universal: ["arm64", "x86_64"] }[
    values.arch
  ];
  if (!architectures) throw new Error(`Unsupported macOS architecture: ${values.arch}`);
  const desktopDirectory = NodeURL.fileURLToPath(new URL("../", import.meta.url));
  const source = NodePath.join(desktopDirectory, "native/window-material/WindowMaterial.m");
  const output =
    values.output ??
    NodePath.join(desktopDirectory, ".electron-runtime/window-material/otter-window-material.node");
  const metadata = `${output}.build.json`;
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(values.arch)
    .update(NodeFS.readFileSync(source))
    .update(NodeFS.readFileSync(NodeURL.fileURLToPath(import.meta.url)))
    .digest("hex");
  let current = false;
  try {
    current =
      JSON.parse(NodeFS.readFileSync(metadata, "utf8")).fingerprint === fingerprint &&
      NodeChildProcess.spawnSync("codesign", ["--verify", "--strict", output], {
        stdio: "ignore",
      }).status === 0;
  } catch {}

  if (!current) {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "otter-window-material-"));
    const temporary = NodePath.join(directory, "otter-window-material.node");
    try {
      NodeChildProcess.execFileSync(
        "xcrun",
        [
          "clang",
          "-x",
          "objective-c",
          "-fobjc-arc",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          ...architectures.flatMap((arch) => ["-arch", arch]),
          "-mmacosx-version-min=12.3",
          "-bundle",
          "-undefined",
          "dynamic_lookup",
          "-framework",
          "AppKit",
          source,
          "-o",
          temporary,
        ],
        { stdio: "inherit", env: { ...process.env, CLANG_MODULE_CACHE_PATH: directory } },
      );
      NodeChildProcess.execFileSync(
        "codesign",
        ["--force", "--sign", "-", "--timestamp=none", temporary],
        { stdio: "inherit" },
      );
      NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
      const pendingOutput = `${output}.${process.pid}.tmp`;
      NodeFS.copyFileSync(temporary, pendingOutput);
      NodeFS.renameSync(pendingOutput, output);
      NodeFS.writeFileSync(metadata, `${JSON.stringify({ fingerprint })}\n`);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  }
}
