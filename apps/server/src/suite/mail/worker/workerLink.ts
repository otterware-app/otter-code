// @effect-diagnostics nodeBuiltinImport:off -- Runs in Mail's worker thread, outside any Effect runtime.
/**
 * The worker's line to the server's main thread, shared by the worker entry,
 * the Platform and the shims that stand in for Mail's Electron main process.
 * Asks that need a person (open a URL, pick files) go to the client whose
 * invoke caused them, tracked with NodeAsyncHooks.AsyncLocalStorage across core's awaits.
 */
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodeWorkerThreads from "node:worker_threads";

import type { FromMailWorker, MailClientRequestKind, MailWorkerData } from "./protocol.ts";

export const mailWorkerData = NodeWorkerThreads.workerData as MailWorkerData;

export function post(message: FromMailWorker): void {
  NodeWorkerThreads.parentPort?.postMessage(message);
}

/** The client whose request core is serving now (null in background work). */
export const currentClient = new NodeAsyncHooks.AsyncLocalStorage<string>();

let nextRequestId = 1;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

/** Asks a client (the one that caused this, else the server picks one) and waits for its answer. */
export function requestClient<T>(kind: MailClientRequestKind, params?: unknown): Promise<T> {
  const id = nextRequestId++;
  post({ type: "request", id, clientId: currentClient.getStore() ?? null, kind, params });
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
  });
}

/** A client's answer to `requestClient`. */
export function settleClientRequest(id: number, result: unknown, error: string | undefined): void {
  const request = pending.get(id);
  pending.delete(id);
  if (error !== undefined) request?.reject(new Error(error));
  else request?.resolve(result);
}
