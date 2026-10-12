// @effect-diagnostics nodeBuiltinImport:off -- Probes Node SEA paths without an Effect runtime.
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { resolveMailWorkerScript } from "./MailWorkerHost.ts";

vi.mock("node:sea", () => ({ isSea: vi.fn() }));
vi.mock("node:url", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeURL>()),
  fileURLToPath: vi.fn(),
}));
vi.mock("./worker/buildMailWorker.ts", () => ({
  ensureDevMailWorker: vi.fn(async (cache: string) =>
    NodePath.join(cache, "otter-mail-worker.mjs"),
  ),
}));

afterEach(() => vi.resetAllMocks());

it("resolves the SEA worker beside the executable before touching its module URL", async () => {
  vi.mocked(NodeSea.isSea).mockReturnValue(true);
  vi.mocked(NodeURL.fileURLToPath).mockImplementation(() => {
    throw new Error("SEA modules have no file URL");
  });
  expect(await resolveMailWorkerScript()).toBe(
    NodePath.join(NodePath.dirname(process.execPath), "otter-mail-worker.mjs"),
  );
  expect(NodeURL.fileURLToPath).not.toHaveBeenCalled();
});

it("resolves the desktop worker beside the bundled server", async () => {
  vi.mocked(NodeSea.isSea).mockReturnValue(false);
  vi.mocked(NodeURL.fileURLToPath).mockReturnValue(NodePath.resolve("desktop/server/bin.mjs"));
  expect(await resolveMailWorkerScript()).toBe(
    NodePath.resolve("desktop/server/otter-mail-worker.mjs"),
  );
});

it("keeps the development worker in the server cache", async () => {
  vi.mocked(NodeSea.isSea).mockReturnValue(false);
  const source = new URL("./MailWorkerHost.ts", import.meta.url).pathname;
  vi.mocked(NodeURL.fileURLToPath).mockReturnValue(source);
  const { ensureDevMailWorker } = await import("./worker/buildMailWorker.ts");
  vi.mocked(ensureDevMailWorker).mockResolvedValue("cached-worker.mjs");
  expect(await resolveMailWorkerScript()).toBe("cached-worker.mjs");
  expect(ensureDevMailWorker).toHaveBeenCalledWith(
    NodePath.resolve(NodePath.dirname(source), "../../../node_modules/.cache/otter-mail-worker"),
  );
});
