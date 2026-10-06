// @effect-diagnostics nodeBuiltinImport:off -- Reads the host name for Mail's device list.
/**
 * Otter Mail on this server: Mail's core in a worker thread
 * (`MailWorkerHost.ts`), started on first use, and the clients (Mail frames)
 * subscribed to its pushes. RPC handlers, the agent tools and Home all go
 * through here.
 *
 * Mail keeps its own files in `<stateDir>/mail` (`mail-demo` for the demo
 * mailbox, `OTTER_MAIL_FAKE_DEMO=1`), never in the shared databases.
 */
import * as NodeOS from "node:os";

import {
  decodeMailBytes,
  encodeMailBytes,
  SuiteMailError,
  type SuiteMailEvent,
  type SuiteMailInvokeInput,
} from "@t3tools/contracts/suite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { MailWorkerHost, resolveMailWorkerScript, type MailWorkerPush } from "./MailWorkerHost.ts";
import type {
  MailHomeEntry,
  MailToolCaller,
  MailToolDescriptor,
  MailWorkerCall,
  MailWorkerCalls,
} from "./worker/protocol.ts";

const SEAL_KEY_SECRET = "otterware-mail-seal";
const DEFAULT_RELAY_URL = "https://relay.mail.otterware.app";

export class MailService extends Context.Service<
  MailService,
  {
    /** A Mail renderer's `desktopBridge.invoke`. */
    readonly invoke: (input: SuiteMailInvokeInput) => Effect.Effect<unknown, SuiteMailError>;
    /** Core's pushes, and its asks of this client; starts core. */
    readonly events: (clientId: string) => Stream.Stream<SuiteMailEvent>;
    readonly reply: (input: {
      readonly clientId: string;
      readonly id: number;
      readonly result?: unknown;
      readonly error?: string | undefined;
    }) => Effect.Effect<void>;
    /** Mail's agent tools; needs no running core. */
    readonly listTools: Effect.Effect<ReadonlyArray<MailToolDescriptor>, SuiteMailError>;
    readonly callTool: (
      caller: MailToolCaller,
      name: string,
      args: Record<string, unknown>,
    ) => Effect.Effect<{ readonly text: string; readonly isError: boolean }, SuiteMailError>;
    readonly needsYou: Effect.Effect<ReadonlyArray<MailHomeEntry>, SuiteMailError>;
    readonly homeAction: (itemId: string, actionId: string) => Effect.Effect<void, SuiteMailError>;
  }
>()("t3/suite/mail/MailService") {}

type CoreStatus =
  | { readonly type: "idle" }
  | { readonly type: "starting" }
  | { readonly type: "ready"; readonly channels: ReadonlyArray<string> }
  | { readonly type: "failed"; readonly message: string };

interface Client {
  readonly queue: Queue.Queue<SuiteMailEvent, Cause.Done>;
  readonly subscribedAt: number;
}

const toMailError = (cause: unknown, channel?: string) =>
  new SuiteMailError({
    detail: cause instanceof Error ? cause.message : String(cause),
    ...(channel === undefined ? {} : { channel }),
  });

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  const demo = process.env.OTTER_MAIL_FAKE_DEMO?.trim() === "1";
  // The server's secret store keeps the key; a server without one (tests) seals for this run only.
  const secretStore = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const sealKey = Option.isSome(secretStore)
    ? yield* secretStore.value.getOrCreateRandom(SEAL_KEY_SECRET, 32)
    : yield* crypto.randomBytes(32);
  const clients = new Map<string, Client>();
  let status: CoreStatus = { type: "idle" };
  let unread: number | null = null;
  let starting: Promise<void> | null = null;

  const toAll = (event: SuiteMailEvent) => {
    for (const client of clients.values()) Queue.offerUnsafe(client.queue, event);
  };

  /** The client a request goes to: the one that caused it, else the newest. */
  const clientFor = (clientId: string | null) =>
    (clientId === null ? undefined : clients.get(clientId)) ??
    [...clients.values()].toSorted((a, b) => b.subscribedAt - a.subscribedAt)[0];

  const onPush = (push: MailWorkerPush) => {
    switch (push.type) {
      case "event":
        toAll({
          type: "event",
          channel: push.channel,
          ...(push.params === undefined ? {} : { params: encodeMailBytes(push.params) }),
        });
        return;
      case "notify": {
        const { type: _type, ...notification } = push;
        toAll({ type: "notify", ...notification });
        return;
      }
      case "unread":
        unread = push.count;
        toAll({ type: "unread", count: push.count });
        return;
      case "request": {
        const client = clientFor(push.clientId);
        if (client === undefined) {
          host.reply(
            push.id,
            undefined,
            "No Otterware window is open to do this. Open Mail and try again.",
          );
          return;
        }
        Queue.offerUnsafe(client.queue, {
          type: "request",
          id: push.id,
          kind: push.kind,
          ...(push.params === undefined ? {} : { params: encodeMailBytes(push.params) }),
        });
        return;
      }
      case "log": {
        const annotations = {
          scope: push.scope,
          ...(push.data === undefined ? {} : { data: push.data }),
        };
        const log =
          push.level === "error"
            ? Effect.logError(push.message, annotations)
            : push.level === "warn"
              ? Effect.logWarning(push.message, annotations)
              : push.level === "info"
                ? Effect.logInfo(push.message, annotations)
                : Effect.logDebug(push.message, annotations);
        runFork(log.pipe(Effect.annotateLogs({ module: "mail" })));
        return;
      }
    }
  };

  const host = new MailWorkerHost({
    script: resolveMailWorkerScript,
    data: {
      home: path.join(config.stateDir, demo ? "mail-demo" : "mail"),
      sealKey,
      demo,
      relayUrl: process.env.OTTER_MAIL_RELAY_URL?.trim() || DEFAULT_RELAY_URL,
      deviceName: `Otterware on ${NodeOS.hostname()}`,
    },
    onPush,
    onExit: (error) => {
      starting = null;
      status = { type: "failed", message: error.message };
      toAll({ type: "failed", message: error.message });
      runFork(Effect.logError("Mail's worker stopped", { cause: error.message }));
    },
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => host.terminate()));

  /** Starts core once (again after a failure); every call that needs core waits for it. */
  const ensureStarted = (): Promise<void> =>
    (starting ??= (async () => {
      status = { type: "starting" };
      try {
        const { channels } = await host.call("start", undefined);
        status = { type: "ready", channels };
        toAll({ type: "ready", channels: [...channels] });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status = { type: "failed", message };
        toAll({ type: "failed", message });
        starting = null;
        throw error;
      }
    })());

  const call = <K extends MailWorkerCall>(
    method: K,
    params: MailWorkerCalls[K]["params"],
    options: { readonly needsCore: boolean; readonly channel?: string },
  ) =>
    Effect.tryPromise({
      try: async () => {
        if (options.needsCore) await ensureStarted();
        return host.call(method, params);
      },
      catch: (cause) => toMailError(cause, options.channel),
    });

  if (demo) yield* Effect.logInfo("Mail runs the demo mailbox (OTTER_MAIL_FAKE_DEMO=1).");

  return MailService.of({
    invoke: ({ clientId, channel, params }) =>
      call(
        "invoke",
        { clientId, channel, params: decodeMailBytes(params) },
        { needsCore: true, channel },
      ).pipe(Effect.map(encodeMailBytes)),
    events: (clientId) =>
      Stream.callback<SuiteMailEvent>((queue) =>
        Effect.gen(function* () {
          clients.set(clientId, { queue, subscribedAt: yield* Clock.currentTimeMillis });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (clients.get(clientId)?.queue === queue) clients.delete(clientId);
            }),
          );
          if (status.type === "ready") {
            Queue.offerUnsafe(queue, { type: "ready", channels: [...status.channels] });
          } else if (status.type === "failed") {
            Queue.offerUnsafe(queue, { type: "failed", message: status.message });
          }
          if (unread !== null) Queue.offerUnsafe(queue, { type: "unread", count: unread });
          // A client opening Mail is what starts it; ensureStarted reports the outcome to everyone.
          ensureStarted().catch(() => {});
        }),
      ),
    reply: ({ clientId, id, result, error }) =>
      Effect.sync(() => {
        if (!clients.has(clientId)) return;
        host.reply(id, result === undefined ? undefined : decodeMailBytes(result), error);
      }),
    listTools: call("tools", undefined, { needsCore: false }),
    callTool: (caller, name, args) =>
      call(
        "callTool",
        { caller, name, args: decodeMailBytes(args) as Record<string, unknown> },
        {
          needsCore: true,
        },
      ),
    needsYou: call("needsYou", undefined, { needsCore: true }),
    homeAction: (itemId, actionId) => call("homeAction", { itemId, actionId }, { needsCore: true }),
  });
});

export const layer = Layer.effect(MailService, make);
