// @effect-diagnostics nodeBuiltinImport:off -- Exercises the plain Node worker host outside an Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { MailWorkerHost, resolveMailWorkerScript } from "./MailWorkerHost.ts";

it("starts once, keeps the SQLite cache in Mail's home, and reports missing Google OAuth", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "otterware-mail-platform-"));
  const host = new MailWorkerHost({
    script: resolveMailWorkerScript,
    data: {
      home,
      sealKey: new Uint8Array(32),
      demo: false,
      relayUrl: "https://relay.mail.otterware.app",
      deviceName: "Test",
    },
    onPush: () => {},
    onExit: () => {},
  });
  try {
    const [first, second] = await Promise.all([
      host.call("start", undefined),
      host.call("start", undefined),
    ]);
    expect(first).toEqual(second);
    expect(first.channels).toContain("gmail:listAccounts");
    expect((await NodeFSP.stat(NodePath.join(home, "mail-cache.db"))).isFile()).toBe(true);
    // No credentials are passed to the test worker or baked into the test build.
    await expect(
      host.call("invoke", { clientId: null, channel: "gmail:addAccount", params: {} }),
    ).rejects.toThrow("isn't configured in this Otterware build");
  } finally {
    await host.terminate();
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
