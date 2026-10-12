import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type { JoinPath } from "./DesktopStatePaths.ts";

// Otterware keeps its desktop-only files (settings, connection catalog, account
// session, logs, ...) in its own home, while the bundled backend keeps sharing
// the Otter Code home (T3CODE_HOME, default ~/.otter-code) so it sees the
// user's existing threads and projects.

/** Desktop-owned files copied once from the Otter Code state dir on first start. */
export const LEGACY_CLIENT_STATE_FILES = [
  "desktop-settings.json",
  "client-settings.json",
  "saved-environments.json",
] as const;

const MIGRATION_MARKER_FILE = ".migrated-from-otter-code";

const nonBlank = (value: Option.Option<string>) =>
  Option.filter(
    Option.map(value, (text) => text.trim()),
    (text) => text.length > 0,
  );

/**
 * Resolves where desktop-only state lives. `OTTERWARE_HOME` wins. Without it,
 * development keeps everything in its isolated backend home. Production
 * always splits desktop files into `~/.otterware/userdata`, even when
 * `T3CODE_HOME` explicitly selects the shared server home.
 */
export function resolveOtterwareClientStateDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly otterwareHome: Option.Option<string>;
  readonly t3Home: Option.Option<string>;
  readonly isDevelopment: boolean;
  readonly backendStateDir: string;
}): string {
  const configured = nonBlank(input.otterwareHome);
  if (Option.isSome(configured)) return input.joinPath(configured.value, "userdata");
  if (input.isDevelopment) return input.backendStateDir;
  return input.joinPath(input.homeDirectory, ".otterware", "userdata");
}

/**
 * Copies desktop files from the shared Otter Code state dir into the client
 * state dir once. Never moves or deletes: plain Otter Code still uses them. A
 * marker keeps a later sign-out or reset from being undone by a re-copy.
 * Returns the copied file names.
 */
export const migrateLegacyClientState = Effect.fn("desktop.otterware.migrateLegacyClientState")(
  function* (input: {
    readonly clientStateDir: string;
    readonly legacyStateDir: string;
    readonly joinPath: JoinPath;
  }) {
    if (input.clientStateDir === input.legacyStateDir) return [];
    const fs = yield* FileSystem.FileSystem;
    const marker = input.joinPath(input.clientStateDir, MIGRATION_MARKER_FILE);
    if (yield* fs.exists(marker)) return [];
    yield* fs.makeDirectory(input.clientStateDir, { recursive: true });
    const copied: string[] = [];
    for (const name of LEGACY_CLIENT_STATE_FILES) {
      const from = input.joinPath(input.legacyStateDir, name);
      const to = input.joinPath(input.clientStateDir, name);
      if ((yield* fs.exists(to)) || !(yield* fs.exists(from))) continue;
      yield* fs.copyFile(from, to);
      copied.push(name);
    }
    yield* fs.writeFileString(marker, "");
    return copied;
  },
);

/** Startup step: runs the one-time copy and never fails startup. */
export const migrateDesktopClientState = (environment: {
  readonly clientStateDir: string;
  readonly stateDir: string;
  readonly path: { readonly join: JoinPath };
}) =>
  migrateLegacyClientState({
    clientStateDir: environment.clientStateDir,
    legacyStateDir: environment.stateDir,
    joinPath: environment.path.join,
  }).pipe(
    Effect.tap((copied) =>
      copied.length > 0
        ? Effect.logInfo("copied desktop state from Otter Code", {
            copied,
            from: environment.stateDir,
            to: environment.clientStateDir,
          })
        : Effect.void,
    ),
    Effect.catch((error) =>
      Effect.logWarning("could not copy desktop state from Otter Code", { error: error.message }),
    ),
  );
