import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { SshCommandError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;

describe("ssh tunnel scripts", () => {
  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteT3RunnerScript(ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reports the real exit when reading tunnel diagnostics fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
                  Stream.concat(
                    Stream.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "Stream",
                        method: "read",
                        description: "stderr read failed",
                      }),
                    ),
                  ),
                ),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );
});

// Exercise the generated shell with fake helpers and a deterministic clock.
// No fixture starts a server or signals a real PID.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote launch service ownership",
  () => {
    const cases = [
      { name: "active service with a ready server", marker: "active", server: "up" },
      {
        name: "pending trial publishes runtime before readiness",
        marker: "pending",
        server: "restart",
      },
      { name: "service never starts", marker: "active", server: "down" },
      { name: "enabled systemd service restarts", marker: "enabled", server: "restart" },
      { name: "installed systemd unit with no service state", marker: "unit", server: "up" },
      { name: "installed launchd plist with no service state", marker: "plist", server: "up" },
      { name: "invalid service state fails closed", marker: "invalid", server: "down" },
      { name: "host without a service spawns managed", marker: "none", server: "down" },
      { name: "host without a service reuses external", marker: "none", server: "up" },
      {
        name: "ready service stops stale managed PID",
        marker: "active",
        server: "up",
        stale: "other",
      },
      {
        name: "stale ownership cannot kill the service PID",
        marker: "active",
        server: "up",
        stale: "same",
      },
      {
        name: "down service never reuses stale managed server",
        marker: "active",
        server: "down",
        stale: "other",
      },
    ] as const;

    it.effect.each(cases)("$name", (testCase) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({
          directory: "/tmp",
          prefix: "otter-ssh-service-",
        });
        const home = `${root}/home`;
        const serverHome = `${home}/.otter-code`;
        const stateDir = `${serverHome}/ssh-launch/fixture`;
        const runtimeDir = `${serverHome}/runtime/versions/${ARCHIVE.archiveVersion}`;
        const runtimeFile = `${serverHome}/userdata/server-runtime.json`;
        for (const dir of [stateDir, runtimeDir, `${serverHome}/userdata`, `${root}/bin`]) {
          yield* fs.makeDirectory(dir, { recursive: true });
        }
        yield* fs.writeFileString(`${home}/ticks`, "0");
        yield* fs.writeFileString(`${runtimeDir}/.install-complete`, ARCHIVE.archiveVersion);
        const runtime = JSON.stringify({
          pid: process.pid,
          port: 4773,
          origin: "http://127.0.0.1:4773",
        });
        if (testCase.server === "up") {
          yield* fs.writeFileString(runtimeFile, runtime);
          yield* fs.writeFileString(`${home}/ready`, "4773\n");
        } else if (testCase.server === "restart") {
          // A dead child's metadata must be reread, and readiness may lag it.
          yield* fs.writeFileString(runtimeFile, JSON.stringify({ pid: 0, port: 4772 }));
          yield* fs.writeFileString(`${home}/next-runtime`, runtime);
        }
        if (["active", "pending", "invalid"].includes(testCase.marker)) {
          const state =
            testCase.marker === "active"
              ? { activeVersion: "1.2.3" }
              : { update: { status: "pending" } };
          yield* fs.writeFileString(
            `${serverHome}/runtime/service-state.json`,
            testCase.marker === "invalid" ? "{" : JSON.stringify(state),
          );
        } else if (testCase.marker === "unit" || testCase.marker === "plist") {
          const unitDir =
            testCase.marker === "unit"
              ? `${home}/.config/systemd/user`
              : `${home}/Library/LaunchAgents`;
          yield* fs.makeDirectory(unitDir, { recursive: true });
          yield* fs.writeFileString(
            `${unitDir}/${testCase.marker === "unit" ? "otter-code.service" : "dev.otterware.code.service.plist"}`,
            "fixture",
          );
        } else if (testCase.marker === "enabled") {
          yield* fs.writeFileString(`${home}/enabled`, "");
        }
        const stale = "stale" in testCase ? testCase.stale : undefined;
        if (stale) {
          yield* fs.writeFileString(
            `${stateDir}/pid`,
            String(stale === "same" ? process.pid : 424242),
          );
          yield* fs.writeFileString(`${stateDir}/port`, "4774");
          yield* fs.writeFileString(`${stateDir}/managed`, "managed");
        }
        const executable = `${runtimeDir}/t3`;
        yield* fs.writeFileString(
          executable,
          `#!/bin/sh
set -eu
case "$1" in
  --version) exit 0 ;;
  __ssh-helper)
    shift
    case "$1" in
      runtime-port)
        "$T3_TEST_NODE" -e 'try { const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (!r.pid) process.exit(1); process.kill(r.pid, 0); process.stdout.write(r.pid + " " + r.port); } catch { process.exit(1); }' "$2" ;;
      wait-ready)
        if [ "$2" = "4774" ]; then exit 0; fi
        [ -f "$HOME/ready" ] && [ "$(cat "$HOME/ready")" = "$2" ] ;;
      pick-port) printf '4774' ;;
      *) exit 99 ;;
    esac ;;
  *) exit 99 ;;
esac
`,
        );
        yield* fs.chmod(executable, 0o700);
        // Shadow systemctl unconditionally so tests cannot query the live unit.
        yield* fs.writeFileString(
          `${root}/bin/systemctl`,
          `#!/bin/sh
printf '%s\\n' "$*" > "$HOME/systemctl-call"
[ "$*" = "--user is-enabled otter-code.service" ] && [ -f "$HOME/enabled" ]
`,
        );
        yield* fs.chmod(`${root}/bin/systemctl`, 0o700);
        const fakeCommands = `
kill() {
  if [ "$1" = "-0" ]; then [ ! -f "$HOME/killed" ]; return; fi
  printf '%s' "$1" > "$HOME/killed"
}
date() { cat "$HOME/ticks"; }
sleep() {
  TICKS=$(($(cat "$HOME/ticks") + 1))
  printf '%s' "$TICKS" > "$HOME/ticks"
  if [ "$TICKS" -eq 2 ] && [ -f "$HOME/next-runtime" ]; then
    mv "$HOME/next-runtime" "$HOME/.otter-code/userdata/server-runtime.json"
  fi
  if [ "$TICKS" -eq 3 ] && [ "${testCase.server}" = "restart" ]; then printf '4773' > "$HOME/ready"; fi
}
nohup() { printf '%s\\n' "$*" > "$HOME/spawned"; }
`;
        const script = `${root}/launch.sh`;
        yield* fs.writeFileString(
          script,
          fakeCommands + SshTunnel.buildRemoteLaunchScript(ARCHIVE),
        );
        const child = yield* spawner.spawn(
          ChildProcess.make("sh", [script, "fixture"], {
            env: {
              HOME: home,
              PATH: `${root}/bin:${process.env.PATH ?? ""}`,
              T3_TEST_NODE: process.execPath,
            },
            extendEnv: false,
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        const failure = testCase.marker !== "none" && testCase.server === "down";
        assert.equal(exitCode, failure ? 1 : 0, stderr);
        const managed = testCase.marker === "none" && testCase.server === "down";
        assert.equal(yield* fs.exists(`${home}/spawned`), managed);
        if (failure) {
          assert.equal(stdout, "");
          assert.include(stderr, "This host's Otter Code service is not running");
          assert.include(stderr, "otter-code service restart");
          assert.include(stderr, "systemctl --user start otter-code.service");
          assert.equal(Number(yield* fs.readFileString(`${home}/ticks`)), 120);
        } else {
          assert.deepEqual(JSON.parse(stdout), {
            remotePort: managed ? 4774 : 4773,
            serverKind: managed ? "managed" : "external",
          });
          assert.equal(
            (yield* fs.readFileString(`${stateDir}/managed`)).trim(),
            managed ? "managed" : "external",
          );
          assert.equal(yield* fs.exists(`${stateDir}/pid`), managed);
          if (testCase.server === "restart")
            assert.equal(Number(yield* fs.readFileString(`${home}/ticks`)), 3);
          if (managed)
            assert.include(
              yield* fs.readFileString(`${home}/spawned`),
              `serve --host 127.0.0.1 --port 4774 --base-dir ${serverHome}`,
            );
        }
        assert.equal(yield* fs.exists(`${home}/killed`), stale === "other" && !failure);
        if (stale === "other" && !failure)
          assert.equal(yield* fs.readFileString(`${home}/killed`), "424242");
        if (testCase.marker === "enabled" || testCase.marker === "none") {
          assert.equal(
            (yield* fs.readFileString(`${home}/systemctl-call`)).trim(),
            "--user is-enabled otter-code.service",
          );
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
