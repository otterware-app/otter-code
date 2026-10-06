import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("../../../../desktop/node_modules/electron/index.js", () => ({
  protocol: { handle, unhandle: vi.fn() },
}));
import { ElectronProtocol, layer } from "../../../../desktop/src/electron/ElectronProtocol.ts";

describe("Mail frame in the desktop protocol", () => {
  it.effect("serves the second HTML entry as HTML, preserving a same-origin frame", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${directory}/index.html`, "Otterware shell");
        yield* fs.writeFileString(`${directory}/mail-frame.html`, "Mail frame");
        yield* (yield* ElectronProtocol).registerDesktopProtocol({
          scheme: "otterware",
          assetDirectory: directory,
        });
        const serve = handle.mock.calls.at(-1)![1] as (request: Request) => Promise<Response>;
        const response = yield* Effect.promise(() =>
          serve(new Request("otterware://app/mail-frame.html")),
        );
        expect(yield* Effect.promise(() => response.text())).toBe("Mail frame");
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("content-security-policy")).toContain("frame-src 'self'");
      }),
    ).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});
