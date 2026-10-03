// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  languageServerLaunch,
  languageServerStatuses,
  prepareLanguageServerLaunch,
} from "./languageServers.ts";
import { WorkspaceLanguageService } from "./WorkspaceLanguageService.ts";

describe("language server settings", () => {
  let cwd: string;
  let service: WorkspaceLanguageService;
  beforeEach(async () => {
    cwd = await NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lsp-")));
    service = new WorkspaceLanguageService();
  });
  afterEach(async () => {
    service.dispose();
    await NodeFSP.rm(cwd, { recursive: true, force: true });
  });

  it("reports bundled servers and probes a configured command", async () => {
    const fake = NodePath.join(cwd, "fake-rust-analyzer");
    await NodeFSP.writeFile(fake, '#!/bin/sh\necho "rust-analyzer 9.9.9 (fake)"\n', {
      mode: 0o755,
    });
    const statuses = await languageServerStatuses({
      rust: { command: fake },
      protobuf: { command: NodePath.join(cwd, "missing-buf"), enabled: false },
    });
    expect(statuses.find((status) => status.id === "typescript")).toMatchObject({
      bundled: true,
      enabled: true,
      version: expect.stringMatching(/^\d+\.\d+/),
    });
    expect(statuses.find((status) => status.id === "rust")).toMatchObject({
      bundled: false,
      command: fake,
      path: fake,
      version: "rust-analyzer 9.9.9 (fake)",
    });
    expect(statuses.find((status) => status.id === "python")).toMatchObject({
      bundled: true,
      command: null,
      version: expect.stringMatching(/^\d+\.\d+/),
    });
    expect(statuses.find((status) => status.id === "protobuf")).toMatchObject({
      enabled: false,
      path: null,
      version: null,
      installHint: expect.stringContaining("buf"),
    });
  });

  it("refuses a turned-off language and restarts when its command changes", async () => {
    const contents = 'syntax = "proto3";';
    await NodeFSP.writeFile(NodePath.join(cwd, "demo.proto"), contents);
    const request = (settings: Parameters<WorkspaceLanguageService["request"]>[1]) =>
      service.request(
        {
          sessionId: "editor",
          cwd,
          relativePath: "demo.proto",
          operation: "diagnostics",
          version: 1,
          update: { _tag: "open", contents },
        },
        settings,
      );
    await expect(request({ protobuf: { enabled: false } })).rejects.toMatchObject({
      message: expect.stringContaining("turned off in Settings"),
      resync: false,
    });
    const first = NodePath.join(cwd, "first-buf");
    await expect(request({ protobuf: { command: first } })).rejects.toThrow(first);
    const second = NodePath.join(cwd, "second-buf");
    await expect(request({ protobuf: { command: second } })).rejects.toThrow(second);
  });

  describe("missing default servers", () => {
    const originalPath = process.env.PATH;
    let bin: string;
    beforeEach(async () => {
      bin = NodePath.join(cwd, "bin");
      await NodeFSP.mkdir(bin);
      process.env.PATH = [bin, "/usr/bin", "/bin"].join(NodePath.delimiter);
    });
    afterEach(() => {
      process.env.PATH = originalPath;
    });

    it("installs rust-analyzer and rust-src once with the workspace's rustup", async () => {
      const sysroot = NodePath.join(cwd, "sysroot");
      const log = NodePath.join(cwd, "rustup.log");
      await NodeFSP.writeFile(
        NodePath.join(bin, "rustup"),
        `#!/bin/sh
echo "$PWD $*" >> ${log}
case "$1" in
  which) [ -f ${sysroot}/analyzer ] && echo ${sysroot}/analyzer || exit 1 ;;
  component) touch ${sysroot}/analyzer && mkdir -p ${sysroot}/lib/rustlib/src/rust/library ;;
esac
`,
        { mode: 0o755 },
      );
      await NodeFSP.writeFile(NodePath.join(bin, "rustc"), `#!/bin/sh\necho ${sysroot}\n`, {
        mode: 0o755,
      });
      await NodeFSP.mkdir(sysroot);
      const workspace = NodePath.join(cwd, "workspace");
      await NodeFSP.mkdir(workspace);
      const launch = languageServerLaunch("rust", {});
      const file = NodePath.join(workspace, "main.rs");

      expect(await prepareLanguageServerLaunch("rust", launch, workspace, file)).toEqual(launch);
      await prepareLanguageServerLaunch("rust", launch, workspace, file);

      const calls = (await NodeFSP.readFile(log, "utf8")).trim().split("\n");
      expect(calls).toEqual([
        `${workspace} which rust-analyzer`,
        `${workspace} component add rust-analyzer rust-src`,
      ]);
    });

    it("leaves a configured Rust command alone", async () => {
      const launch = languageServerLaunch("rust", { rust: { command: "/opt/rust-analyzer" } });
      await NodeFSP.writeFile(NodePath.join(bin, "rustup"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      expect(await prepareLanguageServerLaunch("rust", launch, cwd, cwd)).toBe(launch);
    });

    it("uses the workspace's own Buf when none is on PATH", async () => {
      const buf = NodePath.join(cwd, "node_modules", ".bin", "buf");
      await NodeFSP.mkdir(NodePath.dirname(buf), { recursive: true });
      await NodeFSP.writeFile(buf, "#!/bin/sh\n", { mode: 0o755 });
      const file = NodePath.join(cwd, "proto", "api", "v1", "service.proto");
      const launch = languageServerLaunch("protobuf", {});

      expect(await prepareLanguageServerLaunch("protobuf", launch, cwd, file)).toEqual({
        ...launch,
        command: buf,
      });
    });
  });
});
