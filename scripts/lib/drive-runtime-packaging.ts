// @effect-diagnostics nodeBuiltinImport:off -- Build-time file URL conversion.
import * as NodeURL from "node:url";
import { isExternalCliDependency, shouldBundleCliDependency } from "./cli-external-packages.ts";

export const DRIVE_RUNTIME_ALIASES = {
  zod: NodeURL.fileURLToPath(
    new URL("../../apps/server/src/suite/drive/zodRuntime.ts", import.meta.url),
  ),
};

// Bare Zod imports must reach the alias before the external-dependency plugin
// runs. The alias only bundles our createRequire loader, never Zod itself;
// Zod stays a staged runtime dependency and the artifact scanner enforces it.
export const SERVER_RUNTIME_DEPENDENCY_OPTIONS = {
  alwaysBundle: (id: string) => id === "zod" || shouldBundleCliDependency(id),
  neverBundle: (id: string) => id !== "zod" && isExternalCliDependency(id),
  onlyBundle: false as const,
};
