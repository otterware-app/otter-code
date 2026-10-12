import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { CliArchiveInputMissingError, stageCliMailWorker } from "./build-cli-archive.ts";

it.layer(NodeServices.layer)("CLI Mail worker staging", (it) => {
  it.effect(
    "copies the worker beside the SEA executable without needing the repository at runtime",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "otterware-cli-worker-" });
        const dist = path.join(root, "server-dist");
        const archive = path.join(root, "archive");
        yield* fs.makeDirectory(dist);
        yield* fs.makeDirectory(archive);
        yield* fs.writeFileString(path.join(archive, "t3"), "SEA fixture");
        yield* fs.writeFileString(
          path.join(dist, "otter-mail-worker.mjs"),
          "export const worker = true;",
        );
        yield* stageCliMailWorker(dist, archive);
        yield* fs.remove(dist, { recursive: true });
        assert.equal(
          yield* fs.readFileString(path.join(archive, "otter-mail-worker.mjs")),
          "export const worker = true;",
        );
        assert.deepStrictEqual((yield* fs.readDirectory(archive)).sort(), [
          "otter-mail-worker.mjs",
          "t3",
        ]);
      }),
  );

  it.effect("refuses to stage an archive with no Mail worker", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "otterware-cli-worker-missing-" });
      const error = yield* stageCliMailWorker(root, root).pipe(Effect.flip);
      assert.instanceOf(error, CliArchiveInputMissingError);
      assert.equal(
        (error as CliArchiveInputMissingError).inputPath,
        path.join(root, "otter-mail-worker.mjs"),
      );
    }),
  );
});
