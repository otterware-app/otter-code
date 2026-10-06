import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ElectronApp from "../electron/ElectronApp.ts";
import type * as ElectronDialog from "../electron/ElectronDialog.ts";

/**
 * A backend that refuses to start because another live server owns its data
 * dir prints one stderr line `OTTERWARE_STATE_DIR_IN_USE {"pid":1,"stateDir":"..."}`
 * before exiting. Kept in sync with apps/server/src/suite/StateDirGuard.ts.
 */
export const STATE_DIR_IN_USE_MARKER = "OTTERWARE_STATE_DIR_IN_USE";

const StateDirInUse = Schema.Struct({ pid: Schema.Number, stateDir: Schema.String });
export type StateDirInUse = typeof StateDirInUse.Type;
const decodeStateDirInUse = Schema.decodeUnknownOption(Schema.fromJsonString(StateDirInUse));

export function parseStateDirInUseLine(line: string): Option.Option<StateDirInUse> {
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${STATE_DIR_IN_USE_MARKER} `)) return Option.none();
  return decodeStateDirInUse(trimmed.slice(STATE_DIR_IN_USE_MARKER.length + 1));
}

const MAX_PENDING_LINE_LENGTH = 16_384;

/** Splits stderr chunks into lines and reports the first in-use marker line. */
export function makeStateDirInUseScanner() {
  const decoder = new TextDecoder();
  let pending = "";
  let found = Option.none<StateDirInUse>();
  const scan = (lines: readonly string[]) => {
    for (const line of lines) {
      if (Option.isSome(found)) return;
      found = parseStateDirInUseLine(line);
    }
  };
  return {
    push: (chunk: Uint8Array) => {
      if (Option.isSome(found)) return;
      const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
      pending = (lines.pop() ?? "").slice(-MAX_PENDING_LINE_LENGTH);
      scan(lines);
    },
    /** Flushes a trailing line without a newline and returns the result. */
    finish: (): Option.Option<StateDirInUse> => {
      scan([pending + decoder.decode()]);
      pending = "";
      return found;
    },
  };
}

/** Asks whether to retry the backend; "Quit" quits the app. Returns true to retry. */
export const makeStateDirInUsePrompt =
  (dialog: ElectronDialog.ElectronDialog["Service"], app: ElectronApp.ElectronApp["Service"]) =>
  (info: StateDirInUse): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const result = yield* dialog.showMessageBox({
        type: "warning",
        title: "Otter Code is already running",
        message: "Otter Code is running with the same data — quit it, then retry.",
        detail: `Data directory: ${info.stateDir}\nProcess: ${info.pid}`,
        buttons: ["Retry", "Quit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) return true;
      yield* app.quit;
      return false;
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("could not show the data-directory-in-use dialog", {
          error: error.message,
        }).pipe(Effect.as(false)),
      ),
    );
