// @effect-diagnostics nodeBuiltinImport:off -- Tests the build-time adapter with a temporary ESM module.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

import { otterMailFrame } from "./otterMailFrame.ts";

it("keeps Mail's hidden agent panel unavailable through default and saved shortcuts", async () => {
  const plugin = otterMailFrame();
  const importer = NodeURL.fileURLToPath(
    new URL("../../../vendor/otter-mail/apps/web/src/main/keybindings/store.ts", import.meta.url),
  );
  const id = await plugin.resolveId.call(
    {} as ThisParameterType<typeof plugin.resolveId>,
    "./commands",
    importer,
  );
  expect(id).toBe("\0otterware:mail-keybinding-commands");
  if (typeof id !== "string") throw new Error("Mail's command module was not adapted.");
  const source = plugin.load.call({} as ThisParameterType<typeof plugin.load>, id);
  expect(typeof source).toBe("string");
  if (typeof source !== "string") throw new Error("Mail's adapted commands were not generated.");
  const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "otterware-mail-commands-"));
  try {
    const module = NodePath.join(temp, "commands.mjs");
    await NodeFSP.writeFile(module, source);
    const commands = await import(NodeURL.pathToFileURL(module).href);
    for (const command of ["agent.toggle", "agent.toggleExpanded", "agent.newTab"]) {
      expect(commands.KEYBINDING_COMMANDS).not.toContain(command);
      expect(
        commands.DEFAULT_KEYBINDINGS.some((rule: { command: string }) => rule.command === command),
      ).toBe(false);
      expect(commands.isKeybindingCommand(command)).toBe(false);
    }
    expect(commands.isKeybindingCommand("message.archive")).toBe(true);
    expect(commands.isKeybindingCommand("label.move:Clients/Acme")).toBe(true);
    expect(commands.DEFAULT_KEYBINDINGS).toContainEqual(
      expect.objectContaining({ key: "e", command: "message.archive" }),
    );
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
});

it("adapts Mail command imports without intercepting the Code client or the upstream re-export", async () => {
  const plugin = otterMailFrame();
  const context = {} as ThisParameterType<typeof plugin.resolveId>;
  const mail = NodeURL.fileURLToPath(
    new URL("../../../vendor/otter-mail/apps/web/src/main/home-view.tsx", import.meta.url),
  );
  for (const source of [
    "./keybindings/commands.ts",
    "./keybindings/commands.js",
    "~/main/keybindings/commands",
  ]) {
    expect(await plugin.resolveId.call(context, source, mail)).toBe(
      "\0otterware:mail-keybinding-commands",
    );
  }
  expect(await plugin.resolveId.call(context, "./commands", "/code/client.ts")).toBeNull();
  expect(
    await plugin.resolveId.call(context, "./commands", "\0otterware:mail-keybinding-commands"),
  ).toBeNull();
});
