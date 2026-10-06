// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { ensureSoleWriter } from "./StateDirGuard.ts";

const encodeRuntimeState = Schema.encodeSync(Schema.fromJsonString(PersistedServerRuntimeState));

const OTHER_PID = 424_242;

const listenOnLoopback = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.succeed(server)));
  }),
  (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
);

const portOf = (server: NodeNet.Server) => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
};

const stateDirWithRuntime = (runtime: { readonly pid: number; readonly port: number } | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped();
    const serverRuntimeStatePath = path.join(stateDir, "server-runtime.json");
    if (runtime !== null) {
      yield* fs.writeFileString(
        serverRuntimeStatePath,
        encodeRuntimeState({
          version: 1,
          pid: runtime.pid,
          port: runtime.port,
          origin: `http://127.0.0.1:${runtime.port}`,
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    return { stateDir, serverRuntimeStatePath };
  });

const guard = (
  paths: { readonly stateDir: string; readonly serverRuntimeStatePath: string },
  alivePids: ReadonlyArray<number>,
) =>
  ensureSoleWriter({
    ...paths,
    ownPid: 1_000,
    isAlive: (pid) => alivePids.includes(pid),
    exitGraceAttempts: 0,
  });

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("StateDirGuard", (it) => {
  it.effect("refuses to start while another live, listening server owns the state dir", () =>
    Effect.gen(function* () {
      const server = yield* listenOnLoopback;
      const paths = yield* stateDirWithRuntime({ pid: OTHER_PID, port: portOf(server) });
      const error = yield* Effect.flip(guard(paths, [OTHER_PID]));
      assert.strictEqual(error._tag, "StateDirInUseError");
      assert.strictEqual(error.pid, OTHER_PID);
      assert.include(error.message, `(pid ${OTHER_PID}) is using ${paths.stateDir}`);
    }),
  );

  it.effect("starts when there is no runtime file", () =>
    Effect.gen(function* () {
      yield* guard(yield* stateDirWithRuntime(null), [OTHER_PID]);
    }),
  );

  it.effect("ignores a stale file whose pid is dead", () =>
    Effect.gen(function* () {
      const server = yield* listenOnLoopback;
      yield* guard(yield* stateDirWithRuntime({ pid: OTHER_PID, port: portOf(server) }), []);
    }),
  );

  it.effect("ignores a reused pid with nothing listening on the recorded port", () =>
    Effect.gen(function* () {
      const server = yield* listenOnLoopback;
      const port = portOf(server);
      yield* Effect.callback<void>((resume) => void server.close(() => resume(Effect.void)));
      yield* guard(yield* stateDirWithRuntime({ pid: OTHER_PID, port }), [OTHER_PID]);
    }),
  );

  it.effect("ignores its own pid", () =>
    Effect.gen(function* () {
      const server = yield* listenOnLoopback;
      yield* guard(yield* stateDirWithRuntime({ pid: 1_000, port: portOf(server) }), [1_000]);
    }),
  );
});
