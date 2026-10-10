// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Runs in Mail's worker thread, outside any Effect runtime.
/**
 * Otter Mail core's Platform on an Otterware server, modelled on Mail's
 * desktop one (apps/desktop/src/platform.ts): files and the mail cache
 * (node:sqlite, WAL) under `<stateDir>/mail`, secrets sealed with the
 * server's key, Mail's PKCE flow with the client's loopback callback forwarded here, and
 * what needs a person (opening the consent page, picking files) asked of the
 * client that caused it. Pushes go to every client over `suite.mail.events`.
 */
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type {
  AsyncContext,
  GmailAccount,
  GoogleAuth,
  MicrosoftAuth,
  PickedFile,
  Platform,
  SqlDatabase,
} from "@otter-mail/core";
import { googleAuth } from "otter-mail-desktop/gmail-oauth";
import { microsoftAuth } from "otter-mail-desktop/microsoft-oauth";
import { connectMailSocket } from "otter-mail-desktop/mail-socket";
import { todoistSignIn } from "otter-mail-desktop/todoist-oauth";

import { sealText, unsealText } from "./seal.ts";
import { runGoogleSignIn } from "./googleAuthRemote.ts";
import { runMicrosoftSignIn } from "./microsoftAuthRemote.ts";
import { mailWorkerData, post, requestClient } from "./workerLink.ts";

declare const __OTTER_MAIL_VERSION__: string;

export const GOOGLE_NOT_CONFIGURED =
  "Google sign-in isn't configured in this Otterware build. Set OTTER_MAIL_GOOGLE_CLIENT_ID and OTTER_MAIL_GOOGLE_CLIENT_SECRET for the server, or add an IMAP mailbox.";

const home = () => mailWorkerData.home;

/** Writes through a temp file, so a crash never leaves half a file. */
async function writeFileAtomic(file: string, data: Uint8Array | string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await NodeFSP.writeFile(tmp, data, { mode: 0o600 });
  await NodeFSP.rename(tmp, file);
}

/** Mail's relative paths stay inside its home. */
function resolveInHome(relative: string): string {
  const root = NodePath.resolve(home());
  const full = NodePath.resolve(root, relative);
  if (full !== root && !full.startsWith(`${root}${NodePath.sep}`)) {
    throw new Error(`Path escapes Mail's data directory: ${relative}`);
  }
  return full;
}

const SECRETS_FILE = "secrets.json";

async function readSecrets(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await NodeFSP.readFile(resolveInHome(SECRETS_FILE), "utf8")) as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

export const nodeFiles: Platform["files"] = {
  async read(file) {
    try {
      return new Uint8Array(await NodeFSP.readFile(resolveInHome(file)));
    } catch {
      return null;
    }
  },
  write: (file, data) => writeFileAtomic(resolveInHome(file), data),
  remove: (file) => NodeFSP.rm(resolveInHome(file), { force: true }),
  async list(dir) {
    const full = resolveInHome(dir);
    const names = await NodeFSP.readdir(full).catch(() => [] as string[]);
    const files = await Promise.all(
      names.map(async (name) => {
        const stat = await NodeFSP.stat(NodePath.join(full, name)).catch(() => null);
        return stat?.isFile() ? { name, size: stat.size, modifiedAt: stat.mtimeMs } : null;
      }),
    );
    return files.filter((file) => file !== null);
  },
};

export const nodeSecrets: Platform["secrets"] = {
  async get(name) {
    const sealed = (await readSecrets())[name];
    return sealed ? unsealText(mailWorkerData.sealKey, sealed) : null;
  },
  async set(name, value) {
    const secrets = await readSecrets();
    secrets[name] = sealText(mailWorkerData.sealKey, value);
    await writeFileAtomic(resolveInHome(SECRETS_FILE), JSON.stringify(secrets, null, 2));
  },
  async delete(name) {
    const secrets = await readSecrets();
    if (!(name in secrets)) return;
    delete secrets[name];
    await writeFileAtomic(resolveInHome(SECRETS_FILE), JSON.stringify(secrets, null, 2));
  },
};

function openDatabase(): SqlDatabase {
  const db = new NodeSqlite.DatabaseSync(resolveInHome("mail-cache.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db as unknown as SqlDatabase;
}

/** Mail's "no OAuth client in this build" error, said the Otterware way. */
async function withGoogleConfigured<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("has no Google OAuth client"))
      throw new Error(GOOGLE_NOT_CONFIGURED, { cause: error });
    throw error;
  }
}

/** Mail owns PKCE and tokens; the adapter captures the callback on the client machine. */
export const serverGoogleAuth: GoogleAuth = {
  ...googleAuth,
  addAccount: (loginHint?: string): Promise<GmailAccount> =>
    runGoogleSignIn(() => withGoogleConfigured(() => googleAuth.addAccount(loginHint))),
  ...(googleAuth.signInForIdToken
    ? {
        signInForIdToken: () =>
          runGoogleSignIn(() => withGoogleConfigured(() => googleAuth.signInForIdToken!())),
      }
    : {}),
};

const resumeListeners = new Set<() => void>();

export const serverMicrosoftAuth: MicrosoftAuth = {
  ...microsoftAuth,
  addAccount: (loginHint) => runMicrosoftSignIn(() => microsoftAuth.addAccount(loginHint)),
};

export function nodePlatform(options: {
  readonly google: GoogleAuth;
  readonly microsoft?: MicrosoftAuth;
  readonly files: Platform["files"];
  readonly relayUrl: string;
  readonly connect: Platform["connect"];
}): Platform {
  let database: SqlDatabase | null = null;
  return {
    kind: "desktop",
    appVersion: __OTTER_MAIL_VERSION__,
    supportDiagnostics: async () => ({
      // oxlint-disable-next-line t3code/no-global-process-runtime -- This plain worker owns its Node runtime, outside Effect.
      environment: `Otterware server (Node ${process.version}, ${NodeOS.platform()} ${NodeOS.arch()})`,
    }),
    log: (level, scope, message, data) =>
      post({
        type: "log",
        level,
        scope,
        message,
        ...(data === undefined ? {} : { data: describe(data) }),
      }),

    database: () => (database ??= openDatabase()),
    connect: options.connect,
    files: options.files,
    secrets: nodeSecrets,
    userFiles: {
      open: (name, bytes) => requestClient<void>("openFile", { name, bytes }),
      save: (name, bytes) => requestClient<boolean>("saveFile", { name, bytes }),
      pick: () => requestClient<PickedFile[]>("pickFiles"),
    },

    google: options.google,
    ...(options.microsoft ? { microsoft: options.microsoft } : {}),
    todoistSignIn,
    relayUrl: options.relayUrl,
    relaySession: "bearer",
    deviceName: mailWorkerData.deviceName,

    broadcast: (channel, params) =>
      post({ type: "event", channel, ...(params === undefined ? {} : { params }) }),
    notify: (notification) => post({ type: "notify", ...notification }),
    setUnreadCount: (count) => post({ type: "unread", count }),
    onResume(listener) {
      resumeListeners.add(listener);
      return () => resumeListeners.delete(listener);
    },
    asyncContext<T>(): AsyncContext<T> {
      const storage = new NodeAsyncHooks.AsyncLocalStorage<T>();
      return { run: (value, fn) => storage.run(value, fn), get: () => storage.getStore() };
    },
    offlineDownloads: true,
    agentProviders: [],
  };
}

/** The network is back (the host saw a client reconnect): core resyncs. */
export function resumePlatform(): void {
  for (const listener of resumeListeners) listener();
}

export const realConnect: Platform["connect"] = connectMailSocket;

function describe(data: unknown): string {
  if (data instanceof Error) return data.stack ?? data.message;
  try {
    return typeof data === "string" ? data : JSON.stringify(data);
  } catch {
    return String(data);
  }
}
