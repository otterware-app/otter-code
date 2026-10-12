// @effect-diagnostics nodeBuiltinImport:off -- A Vite plugin, run by the build outside any Effect runtime.
/**
 * Builds Otterware's Mail frame (`mail-frame.html`, `src/suite/mail/frame`)
 * as a second page of the web app, over Otter Mail's renderer vendored
 * verbatim in vendor/otter-mail/apps/web:
 *
 * - `otter-mail:renderer` is Mail's entry (`main/index.tsx`); the frame
 *   imports it only after installing its `desktopBridge`, and the main web
 *   program never type-checks Mail's code.
 * - Mail's `~/` imports resolve inside Mail's own `src` (Otter Code's `~` is
 *   its own src), and Mail's browser-only bridge, never reached once the
 *   frame provides one, is left out of the bundle.
 * - Mail's build-time constants are globals the frame sets
 *   (`frame/entry.ts`), so Otter Code's own code is unaffected.
 */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { Plugin } from "vite-plus";

const WEB_ROOT = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const MAIL_SRC = NodePath.resolve(WEB_ROOT, "../../vendor/otter-mail/apps/web/src");
const MAIL_ENTRY = NodePath.join(MAIL_SRC, "main/index.tsx");
const WEB_BRIDGE_STUB = "\0otterware:mail-web-bridge";
const MAIL_COMMANDS = NodePath.join(MAIL_SRC, "main/keybindings/commands.ts");
const MAIL_COMMANDS_STUB = "\0otterware:mail-keybinding-commands";

const VIRTUAL_MODULES: Readonly<Record<string, string>> = {
  "otter-mail:renderer": MAIL_ENTRY,
  "otter-mail:settings-search": NodePath.join(MAIL_SRC, "main/settings/settings-search.ts"),
};

export function otterMailFrame() {
  return {
    name: "otterware:mail-frame",
    enforce: "pre",
    config: () => ({
      build: {
        rolldownOptions: {
          input: {
            index: NodePath.join(WEB_ROOT, "index.html"),
            "mail-frame": NodePath.join(WEB_ROOT, "mail-frame.html"),
          },
        },
      },
    }),
    async resolveId(source, importer) {
      const virtual = VIRTUAL_MODULES[source];
      if (virtual) return virtual;
      if (importer === undefined || !importer.startsWith(MAIL_SRC)) return null;
      const mailSource = source.startsWith("~/")
        ? NodePath.join(MAIL_SRC, source.slice(2))
        : source.startsWith(".")
          ? NodePath.resolve(NodePath.dirname(importer), source)
          : source;
      if (mailSource.replace(/\.[cm]?[jt]sx?$/, "") === MAIL_COMMANDS.slice(0, -3)) {
        return MAIL_COMMANDS_STUB;
      }
      if (source.startsWith("~/")) {
        return this.resolve(NodePath.join(MAIL_SRC, source.slice(2)), importer, { skipSelf: true });
      }
      if (source === "../web/bridge" && importer === MAIL_ENTRY) return WEB_BRIDGE_STUB;
      return null;
    },
    load(id) {
      if (id === MAIL_COMMANDS_STUB) {
        // Mail's full-width panel hides its inbox. Its agent commands must be
        // unavailable here, including saved shortcuts and command-palette items:
        // Otterware's Code side chat owns agents, and Mail's panel is hidden.
        const upstream = JSON.stringify(MAIL_COMMANDS);
        return `export * from ${upstream};
import { KEYBINDING_COMMANDS as commands, DEFAULT_KEYBINDINGS as bindings, isKeybindingCommand as isUpstreamCommand } from ${upstream};
export const KEYBINDING_COMMANDS = commands.filter(command => !command.startsWith("agent."));
export const DEFAULT_KEYBINDINGS = bindings.filter(binding => !binding.command.startsWith("agent."));
export const isKeybindingCommand = value => !value.startsWith("agent.") && isUpstreamCommand(value);`;
      }
      if (id !== WEB_BRIDGE_STUB) return null;
      return `export const webBridge = undefined;
export async function requireOtterAccount() {}`;
    },
  } satisfies Plugin;
}
