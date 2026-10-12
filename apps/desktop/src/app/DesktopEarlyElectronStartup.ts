import { fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  OTTERWARE_APP_ID,
  OTTERWARE_DEV_APP_ID,
  OTTERWARE_DEV_SLUG,
  OTTERWARE_SLUG,
} from "@t3tools/shared/otterware";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_LINUX_PASSWORD_STORE,
  normalizeLinuxPasswordStorePreference,
  resolveLinuxPasswordStoreSwitch,
  type LinuxPasswordStoreSwitch,
  type LinuxPasswordStorePreference,
} from "../linuxSecretStorage.ts";
import {
  resolveDesktopBaseDir,
  resolveDesktopStateDir,
  type JoinPath,
} from "./DesktopStatePaths.ts";
import { resolveOtterwareClientStateDir } from "./OtterwarePaths.ts";

interface EarlyDesktopSettingsInput {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly readFileString: (path: string) => string;
}

type EarlyLinuxElectronOptionsInput = EarlyDesktopSettingsInput;

export interface EarlyLinuxElectronOptions {
  readonly isDevelopment: boolean;
  readonly linuxWmClass: string;
  readonly linuxDesktopEntryName: string;
  readonly passwordStore: LinuxPasswordStoreSwitch | null;
}

export const resolveLinuxDesktopEntryName = (isDevelopment: boolean): string =>
  `${isDevelopment ? OTTERWARE_DEV_APP_ID : OTTERWARE_APP_ID}.desktop`;

const trimNonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const EarlyDesktopSettingsJson = fromLenientJson(
  Schema.Struct({
    linuxPasswordStore: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeEarlyDesktopSettingsJson = Schema.decodeSync(EarlyDesktopSettingsJson);

const isDevelopmentEnvironment = (env: NodeJS.ProcessEnv): boolean =>
  trimNonEmpty(env.VITE_DEV_SERVER_URL) !== null;

// The client copy wins; before the first-start migration has copied it, fall
// back to the shared Otter Code state dir so the password store stays stable.
function resolveEarlyDesktopSettingsPaths(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
}): readonly string[] {
  const t3Home = Option.fromUndefinedOr(input.env.T3CODE_HOME);
  const baseDir = resolveDesktopBaseDir({
    homeDirectory: input.homeDirectory,
    joinPath: input.joinPath,
    t3Home,
  });
  const isDevelopment = isDevelopmentEnvironment(input.env);
  const stateDir = resolveDesktopStateDir({
    baseDir,
    isDevelopment,
    joinPath: input.joinPath,
    t3Home,
  });
  const clientStateDir = resolveOtterwareClientStateDir({
    homeDirectory: input.homeDirectory,
    joinPath: input.joinPath,
    otterwareHome: Option.fromUndefinedOr(input.env.OTTERWARE_HOME),
    t3Home,
    isDevelopment,
    backendStateDir: stateDir,
  });
  return [...new Set([clientStateDir, stateDir])].map((dir) =>
    input.joinPath(dir, "desktop-settings.json"),
  );
}

export function resolveEarlyLinuxPasswordStorePreference(
  input: EarlyDesktopSettingsInput,
): LinuxPasswordStorePreference {
  for (const settingsPath of resolveEarlyDesktopSettingsPaths(input)) {
    try {
      const parsed = decodeEarlyDesktopSettingsJson(input.readFileString(settingsPath));
      return normalizeLinuxPasswordStorePreference(parsed.linuxPasswordStore);
    } catch {
      continue;
    }
  }
  return DEFAULT_LINUX_PASSWORD_STORE;
}

export function resolveEarlyLinuxElectronOptions(
  input: EarlyLinuxElectronOptionsInput,
): EarlyLinuxElectronOptions {
  const preference = resolveEarlyLinuxPasswordStorePreference(input);
  const isDevelopment = isDevelopmentEnvironment(input.env);
  return {
    isDevelopment,
    linuxWmClass: isDevelopment ? OTTERWARE_DEV_SLUG : OTTERWARE_SLUG,
    linuxDesktopEntryName: resolveLinuxDesktopEntryName(isDevelopment),
    passwordStore: resolveLinuxPasswordStoreSwitch({
      preference,
      env: input.env,
    }),
  };
}
