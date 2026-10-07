import { expect, it, vi } from "vite-plus/test";
import { isUnusedMailDatabaseDriver, mailWorkerBuildOnLog } from "./buildMailWorker.ts";

it.each([
  ["pg", "/repo/node_modules/@better-auth/kysely-adapter/dist/index.mjs"],
  ["mysql2/promise", "/repo/node_modules/better-auth/dist/db/get-adapter.mjs"],
  ["pg-native", "/repo/node_modules/pg/lib/native/client.js"],
  ["@prisma/client", "/repo/node_modules/@better-auth/prisma-adapter/dist/index.mjs"],
  ["mongodb", "C:\\repo\\node_modules\\@better-auth\\mongo-adapter\\dist\\index.mjs"],
])("allows only the unused adapter driver %s from %s", (source, importer) => {
  expect(isUnusedMailDatabaseDriver(source, importer)).toBe(true);
});

it.each([
  ["better-auth/client", "/repo/vendor/otter-mail/packages/core/src/services/otter-account.ts"],
  ["radix-ui", "/repo/vendor/otter-mail/apps/web/src/main.tsx"],
  ["mysql2/promise", "/repo/apps/server/src/suite/mail/worker/mailWorker.ts"],
  ["pg-native", "/repo/apps/server/src/suite/mail/worker/mailWorker.ts"],
  ["pg/typo", "/repo/node_modules/@better-auth/kysely-adapter/dist/index.mjs"],
  ["missing-driver", "/repo/node_modules/@better-auth/kysely-adapter/dist/index.mjs"],
  ["pg", undefined],
])("does not externalize a required or unknown import %s from %s", (source, importer) => {
  expect(isUnusedMailDatabaseDriver(source, importer)).toBe(false);
});

it("turns unresolved imports into build failures and forwards other diagnostics", () => {
  const missing = { code: "UNRESOLVED_IMPORT", message: "Could not resolve better-auth/client" };
  const warning = { code: "CIRCULAR_DEPENDENCY", message: "Cycle" };
  const handler = vi.fn((level: string, log: { message: string }) => {
    if (level === "error") throw new Error(log.message);
  });
  expect(() => mailWorkerBuildOnLog("warn", missing, handler)).toThrow(missing.message);
  expect(handler).toHaveBeenCalledWith("error", missing);
  mailWorkerBuildOnLog("warn", warning, handler);
  expect(handler).toHaveBeenCalledWith("warn", warning);
});
