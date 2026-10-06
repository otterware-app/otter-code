// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- The worker thread's entry, outside any Effect runtime.
/**
 * Otter Mail's core in a worker thread of the Otterware server, the way
 * Mail's desktop runs it in a utility process (apps/desktop/src/backend.ts).
 * The main thread (`../MailWorkerHost.ts`) calls in (`protocol.ts`); core
 * starts on the first call that needs it. Core logs every IPC call with
 * console.log; those become debug lines in the server's log.
 */
import * as NodeFS from "node:fs/promises";
import { parentPort } from "node:worker_threads";

import { handle, registeredHandlers, startCore, syncAllAccounts } from "@otter-mail/core";

import {
  DEMO_RELAY_URL,
  demoGoogleAuth,
  installFakeGmail,
} from "../../../../../../vendor/otter-mail/apps/web/src/web/demo/gmail.ts";
import { mailNeedsYou, parseHomeItemId } from "./home.ts";
import { nodeFiles, nodePlatform, realConnect, serverGoogleAuth } from "./nodePlatform.ts";
import type { MailWorkerCalls, ToMailWorker } from "./protocol.ts";
import { callMailTool, listMailTools } from "./tools.ts";
import { currentClient, mailWorkerData, post, settleClientRequest } from "./workerLink.ts";

const forward =
  (level: "debug" | "warn" | "error") =>
  (...args: unknown[]) =>
    post({
      type: "log",
      level,
      scope: "otter-mail",
      message: args.map((arg) => (typeof arg === "string" ? arg : safeJson(arg))).join(" "),
    });
console.log = forward("debug");
console.info = forward("debug");
console.debug = forward("debug");
console.warn = forward("warn");
console.error = forward("error");

function safeJson(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

let started: Promise<{ channels: ReadonlyArray<string> }> | null = null;

/** Starts core once; the demo puts its fake Gmail in front of this worker's fetch first. */
function start(): Promise<{ channels: ReadonlyArray<string> }> {
  return (started ??= (async () => {
    await NodeFS.mkdir(mailWorkerData.home, { recursive: true, mode: 0o700 });
    if (mailWorkerData.demo) await installFakeGmail(nodeFiles);
    await startCore(
      nodePlatform({
        google: mailWorkerData.demo ? demoGoogleAuth() : serverGoogleAuth,
        files: nodeFiles,
        relayUrl: mailWorkerData.demo ? DEMO_RELAY_URL : mailWorkerData.relayUrl,
        connect: mailWorkerData.demo
          ? () => Promise.reject(new Error("The demo mailbox can't connect to mail servers."))
          : realConnect,
      }),
    );
    // Mail's desktop answers these in its backend process (apps/desktop/src/handlers/backend.ts).
    handle("desktop:syncAll", async () => {
      await syncAllAccounts({ force: true });
      return { ok: true };
    });
    return { channels: [...registeredHandlers().keys()] };
  })());
}

async function invoke(clientId: string | null, channel: string, params: unknown): Promise<unknown> {
  await start();
  const handler = registeredHandlers().get(channel);
  if (!handler) throw new Error(`No handler for ${channel}.`);
  return clientId === null ? handler(params) : currentClient.run(clientId, () => handler(params));
}

const calls: {
  readonly [K in keyof MailWorkerCalls]: (
    params: MailWorkerCalls[K]["params"],
  ) => Promise<MailWorkerCalls[K]["result"]>;
} = {
  start,
  invoke: ({ clientId, channel, params }) => invoke(clientId, channel, params),
  tools: async () => listMailTools(),
  callTool: async ({ caller, name, args }) => {
    await start();
    return callMailTool(caller, name, args);
  },
  needsYou: async () => {
    await start();
    return mailNeedsYou(Date.now());
  },
  homeAction: async ({ itemId, actionId }) => {
    const item = parseHomeItemId(itemId);
    if (item === null || actionId !== "archive") throw new Error(`Unknown action ${actionId}.`);
    await invoke(null, "gmail:modifyThread", {
      accountId: item.accountId,
      threadId: item.threadId,
      removeLabelIds: ["INBOX"],
    });
  },
};

parentPort?.on("message", (message: ToMailWorker) => {
  if (message.type === "reply") {
    settleClientRequest(message.id, message.result, message.error);
    return;
  }
  const call = calls[message.method] as (params: unknown) => Promise<unknown>;
  call(message.params).then(
    (result) => post({ type: "result", id: message.id, result }),
    (error: unknown) =>
      post({
        type: "result",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});
