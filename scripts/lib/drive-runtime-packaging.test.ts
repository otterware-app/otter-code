// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import { build } from "vite-plus/pack";
import { findInlinedExternalPackages } from "./cli-external-packages.ts";
import { findEsmImportsOfExternalPackages } from "./cli-executable-imports.ts";
import {
  DRIVE_RUNTIME_ALIASES,
  SERVER_RUNTIME_DEPENDENCY_OPTIONS,
} from "./drive-runtime-packaging.ts";

it("loads Drive's Zod 4 schemas from staged dependencies with no SEA-incompatible imports", async () => {
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "otterware-drive-package-"));
  try {
    const entry = NodePath.join(scratch, "probe.mjs");
    const output = NodePath.join(scratch, "package");
    const contracts = NodeURL.fileURLToPath(
      new URL("../../vendor/otter-drive/packages/contracts/src/index.ts", import.meta.url),
    );
    await NodeFSP.writeFile(
      entry,
      `
      import assert from "node:assert/strict";
      import { inviteDriveMemberInputSchema } from ${JSON.stringify(contracts)};
      assert.equal(inviteDriveMemberInputSchema.safeParse({email: "person@example.com", role: "viewer"}).success, true);
      assert.equal(inviteDriveMemberInputSchema.safeParse({email: "invalid", role: "viewer"}).success, false);
      console.log("Drive schemas loaded from staged Zod 4");
    `,
    );
    await build({
      config: false,
      entry: [entry],
      outDir: output,
      platform: "node",
      format: "esm",
      dts: false,
      logLevel: "error",
      alias: DRIVE_RUNTIME_ALIASES,
      deps: SERVER_RUNTIME_DEPENDENCY_OPTIONS,
    });
    const probe = NodePath.join(output, "probe.mjs");
    const source = await NodeFSP.readFile(probe, "utf8");
    assert.deepEqual(findEsmImportsOfExternalPackages(source), []);
    assert.deepEqual(findInlinedExternalPackages(source).inlined, []);
    const requireServer = NodeModule.createRequire(
      new URL("../../apps/server/package.json", import.meta.url),
    );
    const zodRoot = NodePath.dirname(requireServer.resolve("zod/package.json"));
    await NodeFSP.mkdir(NodePath.join(output, "node_modules"), { recursive: true });
    await NodeFSP.cp(zodRoot, NodePath.join(output, "node_modules/zod"), { recursive: true });
    const stdout = NodeChildProcess.execFileSync(
      process.execPath,
      ["--no-global-search-paths", probe],
      {
        cwd: output,
        env: { PATH: "", SystemRoot: process.env.SystemRoot ?? "" },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.include(stdout, "Drive schemas loaded from staged Zod 4");
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
});
