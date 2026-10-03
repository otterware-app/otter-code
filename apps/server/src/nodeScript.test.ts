// @effect-diagnostics nodeBuiltinImport:off - runs a CommonJS script from the filesystem.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { runNodeScript } from "./nodeScript.ts";

describe("runNodeScript", () => {
  const originalArgv = process.argv;
  afterEach(() => {
    process.argv = originalArgv;
  });

  it("runs the script with the argv Node would give it", () => {
    const directory = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-node-script-")),
    );
    const script = NodePath.join(directory, "server.cjs");
    const output = NodePath.join(directory, "argv.json");
    NodeFS.writeFileSync(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({ argv: process.argv.slice(1), filename: __filename }));`,
    );

    runNodeScript([script, "--stdio"]);

    expect(JSON.parse(NodeFS.readFileSync(output, "utf8"))).toEqual({
      argv: [script, "--stdio"],
      filename: script,
    });
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });
});
