import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { Command } from "effect/cli";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { APPARMOR_PROFILE_PATH } from "../preview/PreviewBrowserHost.ts";
import { browserCommand } from "./browser.ts";

it.effect("sudo setup inspects the invoking user's Otter browser", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "otter-browser-setup-" });
    const executable = path.join(
      home,
      ".otter-code/tools/chrome-headless-shell/linux-64/123/chrome-headless-shell",
    );
    yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
    yield* fs.writeFileString(executable, "");
    const commands: string[] = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") return Effect.die("Unexpected command");
      commands.push(command.command);
      const output = command.command === "getent" ? `tester:x:1000:1000::${home}:/bin/sh` : "ready";
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.make(new TextEncoder().encode(output)),
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      );
    });

    yield* Command.runWith(browserCommand, { version: "0.0.0" })(["setup"]).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.UserId, 0),
      Effect.provideService(HostProcess.Environment, { SUDO_USER: "tester" }),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        exists: (file) => (file === APPARMOR_PROFILE_PATH ? Effect.succeed(true) : fs.exists(file)),
      }),
    );

    expect(commands).toContain(executable);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
