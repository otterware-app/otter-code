// @effect-diagnostics nodeBuiltinImport:off - tests use POSIX path joining.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { migrateLegacyClientState, resolveOtterwareClientStateDir } from "./OtterwarePaths.ts";

const joinPath = NodePath.posix.join;

const makeEnvironment = (env: Record<string, string | undefined>) =>
  DesktopEnvironment.DesktopEnvironment.pipe(
    Effect.provide(
      DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/dist-electron",
        homeDirectory: "/home/u",
        platform: "linux",
        processArch: "x64",
        appVersion: "1.0.0",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/opt/otterware/resources",
        runningUnderArm64Translation: false,
      }).pipe(Layer.provide(Layer.merge(NodeServices.layer, DesktopConfig.layerTest(env)))),
    ),
  );

describe("resolveOtterwareClientStateDir", () => {
  const base = {
    homeDirectory: "/home/u",
    joinPath,
    backendStateDir: "/home/u/.t3/dev",
    t3Home: Option.none<string>(),
  };

  it("uses ~/.otterware/userdata in production", () => {
    assert.equal(
      resolveOtterwareClientStateDir({
        ...base,
        otterwareHome: Option.none(),
        isDevelopment: false,
      }),
      "/home/u/.otterware/userdata",
    );
  });

  it("keeps development client state beside the dev backend state", () => {
    assert.equal(
      resolveOtterwareClientStateDir({
        ...base,
        otterwareHome: Option.none(),
        isDevelopment: true,
      }),
      "/home/u/.t3/dev",
    );
  });

  it("keeps an explicit T3CODE_HOME self-contained", () => {
    assert.equal(
      resolveOtterwareClientStateDir({
        ...base,
        backendStateDir: "/data/otter/userdata",
        t3Home: Option.some("/data/otter"),
        otterwareHome: Option.none(),
        isDevelopment: false,
      }),
      "/data/otter/userdata",
    );
  });

  it("honors OTTERWARE_HOME in every mode and ignores blank values", () => {
    for (const isDevelopment of [false, true]) {
      assert.equal(
        resolveOtterwareClientStateDir({
          ...base,
          otterwareHome: Option.some(" /tmp/ow "),
          isDevelopment,
        }),
        "/tmp/ow/userdata",
      );
    }
    assert.equal(
      resolveOtterwareClientStateDir({
        ...base,
        otterwareHome: Option.some("  "),
        isDevelopment: false,
      }),
      "/home/u/.otterware/userdata",
    );
  });
});

describe("DesktopEnvironment state split", () => {
  it.effect("keeps the backend on the shared home and desktop files in the client home", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({});
      assert.equal(environment.baseDir, "/home/u/.otter-code");
      assert.equal(environment.stateDir, "/home/u/.otter-code/userdata");
      assert.equal(environment.serverSettingsPath, "/home/u/.otter-code/userdata/settings.json");
      assert.equal(environment.clientStateDir, "/home/u/.otterware/userdata");
      assert.equal(
        environment.desktopSettingsPath,
        "/home/u/.otterware/userdata/desktop-settings.json",
      );
      assert.equal(
        environment.clientSettingsPath,
        "/home/u/.otterware/userdata/client-settings.json",
      );
      assert.equal(environment.logDir, "/home/u/.otterware/userdata/logs");
      assert.equal(
        environment.browserArtifactsDir,
        "/home/u/.otterware/userdata/browser-artifacts",
      );
    }),
  );

  it.effect("applies T3CODE_HOME to the backend and OTTERWARE_HOME to the client", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        T3CODE_HOME: "/data/otter",
        OTTERWARE_HOME: "/data/ow",
      });
      assert.equal(environment.baseDir, "/data/otter");
      assert.equal(environment.stateDir, "/data/otter/userdata");
      assert.equal(environment.clientStateDir, "/data/ow/userdata");
    }),
  );

  it.effect("keeps dev-runner state in the worktree home", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        T3CODE_HOME: "/repo/.t3",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      });
      assert.equal(environment.stateDir, "/repo/.t3/userdata");
      assert.equal(environment.clientStateDir, "/repo/.t3/userdata");
    }),
  );
});

describe("migrateLegacyClientState", () => {
  it.effect("copies missing desktop files once and never touches the source", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "otterware-paths-test-" });
        const legacy = joinPath(root, "otter-code", "userdata");
        const client = joinPath(root, "otterware", "userdata");
        yield* fs.makeDirectory(legacy, { recursive: true });
        yield* fs.makeDirectory(client, { recursive: true });
        yield* fs.writeFileString(joinPath(legacy, "connection-catalog.json"), "catalog");
        yield* fs.writeFileString(joinPath(legacy, "otter-account-session.bin"), "session");
        yield* fs.writeFileString(joinPath(legacy, "desktop-settings.json"), "legacy-settings");
        yield* fs.writeFileString(joinPath(legacy, "statev2.sqlite"), "db");
        yield* fs.writeFileString(joinPath(client, "desktop-settings.json"), "client-settings");

        const input = { clientStateDir: client, legacyStateDir: legacy, joinPath };
        const copied = yield* migrateLegacyClientState(input);
        assert.deepEqual(copied, ["connection-catalog.json", "otter-account-session.bin"]);
        assert.equal(
          yield* fs.readFileString(joinPath(client, "connection-catalog.json")),
          "catalog",
        );
        assert.equal(
          yield* fs.readFileString(joinPath(client, "desktop-settings.json")),
          "client-settings",
        );
        assert.equal(yield* fs.exists(joinPath(client, "statev2.sqlite")), false);
        assert.equal(yield* fs.exists(joinPath(legacy, "otter-account-session.bin")), true);

        // A later sign-out in Otterware must not be undone by another copy.
        yield* fs.remove(joinPath(client, "otter-account-session.bin"));
        assert.deepEqual(yield* migrateLegacyClientState(input), []);
        assert.equal(yield* fs.exists(joinPath(client, "otter-account-session.bin")), false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does nothing when client and backend state share a directory", () =>
    Effect.gen(function* () {
      const copied = yield* migrateLegacyClientState({
        clientStateDir: "/nonexistent/userdata",
        legacyStateDir: "/nonexistent/userdata",
        joinPath,
      });
      assert.deepEqual(copied, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
