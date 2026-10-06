/**
 * One writer per data home. Otterware and plain Otter Code share
 * `~/.otter-code`; two servers on one statev2.sqlite would both run the
 * scheduler, provider sessions and effect worker, so agent work would run
 * twice. A server refuses to start while `server-runtime.json` names another
 * live server that is still listening.
 *
 * Handoffs stay safe: the service launcher terminates the old child and waits
 * for its exit before starting an update trial, `node --watch` (dev-runner)
 * waits for exit before restarting, and a server clears the file on shutdown.
 * A file left by a crash names a dead pid (or a reused pid with nothing on the
 * recorded port) and is ignored. Two servers racing through startup before
 * either has written the file are not covered; the file is written only once
 * a server is serving.
 */
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  isProcessAlive,
  readPersistedServerRuntimeState,
  type PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";

/**
 * Printed to stderr, followed by `{"pid":N,"stateDir":"..."}`, when startup is
 * refused. The desktop app matches it to show a dialog instead of restarting
 * the backend in a loop (apps/desktop/src/backend).
 */
export const STATE_DIR_IN_USE_MARKER = "OTTERWARE_STATE_DIR_IN_USE";

const encodeMarkerDetail = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, stateDir: Schema.String })),
);

export class StateDirInUseError extends Schema.TaggedError<StateDirInUseError>()(
  "StateDirInUseError",
  { pid: Schema.Int, stateDir: Schema.String },
) {
  override get message(): string {
    return `Another Otter Code/Otterware server (pid ${this.pid}) is using ${this.stateDir}. Quit it first.`;
  }
}

export interface StateDirGuardInput {
  readonly stateDir: string;
  readonly serverRuntimeStatePath: string;
  /** Overridable for tests. */
  readonly ownPid?: number;
  readonly isAlive?: (pid: number) => boolean;
  /** How long a conflicting server gets to finish exiting (restart races). */
  readonly exitGraceAttempts?: number;
}

const probeHost = (state: PersistedServerRuntimeState) => {
  try {
    const hostname = new URL(state.origin).hostname;
    return hostname.length > 0 ? hostname.replace(/^\[(.*)\]$/, "$1") : "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
};

/** The live server recorded for this state dir, if it is not this process. */
const findOtherServer = Effect.fn("StateDirGuard.findOtherServer")(function* (
  input: StateDirGuardInput,
) {
  const ownPid = input.ownPid ?? process.pid;
  const isAlive = input.isAlive ?? isProcessAlive;
  const state = yield* readPersistedServerRuntimeState(input.serverRuntimeStatePath);
  if (Option.isNone(state)) return Option.none<PersistedServerRuntimeState>();
  const { pid } = state.value;
  if (pid <= 0 || pid === ownPid || !isAlive(pid)) return Option.none();
  // A pid can be reused after a crash or reboot; a server that owns the state
  // dir is also listening on the port it recorded.
  const net = yield* NetService.NetService;
  const listening = yield* net.hasListenerOnHost(state.value.port, probeHost(state.value));
  return listening ? state : Option.none();
});

/** Fails with `StateDirInUseError` while another live server owns `stateDir`. */
export const ensureSoleWriter = Effect.fn("StateDirGuard.ensureSoleWriter")(function* (
  input: StateDirGuardInput,
) {
  const other = yield* findOtherServer(input).pipe(
    Effect.flatMap((found) =>
      Option.isSome(found)
        ? Effect.fail(new StateDirInUseError({ pid: found.value.pid, stateDir: input.stateDir }))
        : Effect.void,
    ),
    Effect.retry({
      times: input.exitGraceAttempts ?? 12,
      schedule: Schedule.spaced("250 millis"),
    }),
    Effect.result,
  );
  if (other._tag === "Success") return;
  const error = other.failure;
  const detail = yield* encodeMarkerDetail({ pid: error.pid, stateDir: error.stateDir }).pipe(
    Effect.orDie,
  );
  yield* Effect.sync(() => process.stderr.write(`${STATE_DIR_IN_USE_MARKER} ${detail}\n`));
  return yield* error;
});
