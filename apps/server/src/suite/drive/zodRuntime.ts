// @effect-diagnostics nodeBuiltinImport:off -- Disk-backed dependencies need createRequire inside Node SEA.
import * as NodeModule from "node:module";
import type * as Zod from "zod";

// The server bundler aliases Drive's bare Zod import to this module. A SEA
// executable cannot use ESM imports for packages beside it; createRequire
// also works in the normal desktop and web-server bundles.
const requireZod = NodeModule.createRequire(import.meta.url);
export const { z } = requireZod("zod") as typeof Zod;
