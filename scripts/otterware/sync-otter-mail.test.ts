// @effect-diagnostics nodeBuiltinImport:off -- Exercises the synchronous vendor guard outside an Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { runGuards } from "./sync-otter-mail.ts";

function vendorFiles(): Map<string, Buffer> {
  const root = NodePath.resolve("vendor/otter-mail");
  const files = new Map<string, Buffer>();
  for (const file of NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!file.isFile() || file.parentPath.includes("node_modules")) continue;
    const full = NodePath.join(file.parentPath, file.name);
    files.set(NodePath.relative(root, full), NodeFS.readFileSync(full));
  }
  return files;
}

it("accepts the pinned vendor and rejects changed contracts, missing exports, and unhandled channels", async () => {
  const files = vendorFiles();
  const recorded = JSON.parse(
    NodeFS.readFileSync("scripts/otterware/otter-mail-contract.json", "utf8"),
  ) as { declarations: Record<string, string> };
  const extra = new Map([
    [
      "apps/desktop/src/backend-protocol.ts",
      Object.entries(recorded.declarations)
        .filter(([key]) => key.startsWith("apps/desktop/src/backend-protocol.ts#"))
        .map(([, declaration]) => declaration)
        .join("\n"),
    ],
  ]);
  expect((await runGuards(files, extra, "test", false)).failures).toEqual([]);
  for (const [file, before, after, expected] of [
    [
      "packages/core/src/platform.ts",
      "export interface Platform {",
      "export interface Platform { changed: boolean;",
      "#Platform changed",
    ],
    [
      "packages/core/src/platform.ts",
      "export interface MicrosoftAuth {",
      "export interface MicrosoftAuth { changed: boolean;",
      "#MicrosoftAuth changed",
    ],
    [
      "packages/contracts/src/index.ts",
      "export interface DesktopBridge {",
      "export interface DesktopBridge { changed: boolean;",
      "#DesktopBridge changed",
    ],
    [
      "packages/contracts/src/index.ts",
      "export interface BridgeFeatures {",
      "export interface BridgeFeatures { changed: boolean;",
      "#BridgeFeatures changed",
    ],
    ["packages/core/src/index.ts", "startCore", "removedStartCore", "no longer exports startCore"],
    [
      "apps/desktop/src/services/microsoft-oauth.ts",
      "microsoftAuth",
      "removedMicrosoftAuth",
      "no longer exports microsoftAuth",
    ],
  ]) {
    const original = files.get(file!)!;
    expect(original.toString()).toContain(before);
    files.set(file!, Buffer.from(original.toString().replaceAll(before!, after!)));
    expect((await runGuards(files, extra, "test", false)).failures.join("\n")).toContain(expected);
    files.set(file!, original);
  }
  files.set(
    "apps/web/src/main/new-channel.ts",
    Buffer.from('ipc("gmail:unhandledUpstreamChannel")'),
  );
  expect((await runGuards(files, extra, "test", false)).failures.join("\n")).toContain(
    "gmail:unhandledUpstreamChannel",
  );
});
