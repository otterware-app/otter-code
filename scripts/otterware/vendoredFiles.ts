// @effect-diagnostics nodeBuiltinImport:off - read synchronously by the root `vite.config.ts`.
/**
 * Every file an Otterware vendor manifest (`./vendor/*.json`) copies from another repository.
 * The root config keeps them out of `vp fmt` and `vp lint`: they stay as upstream ships them,
 * which `sync-<name>.ts --check` verifies instead.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const vendorDir = NodePath.join(import.meta.dirname, "vendor");

export const OTTERWARE_VENDORED_FILES: ReadonlyArray<string> = NodeFS.readdirSync(vendorDir)
  .filter((name) => name.endsWith(".json"))
  .flatMap((name) => {
    const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(vendorDir, name), "utf8")) as {
      readonly files?: ReadonlyArray<string>;
    };
    return manifest.files ?? [];
  });
