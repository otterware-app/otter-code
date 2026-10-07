// @effect-diagnostics nodeBuiltinImport:off -- Owns a worker_threads NodeWorkerThreads.Worker; MailService wraps it in Effect.
/**
 * The server side of Mail's worker thread (`worker/protocol.ts`): calls with
 * answers, and a listener for everything core pushes. A worker that dies
 * fails its open calls and is started again on the next call.
 */
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";
import * as NodeWorkerThreads from "node:worker_threads";

import type {
  FromMailWorker,
  MailWorkerCall,
  MailWorkerCalls,
  MailWorkerData,
  ToMailWorker,
} from "./worker/protocol.ts";

export type MailWorkerPush = Exclude<FromMailWorker, { readonly type: "result" }>;

/** Where the worker bundle comes from: beside the built server, or built on demand in dev. */
export async function resolveMailWorkerScript(): Promise<string> {
  // A SEA has no file-backed module URL; the archive stages the worker beside its executable.
  if (NodeSea.isSea()) {
    return NodePath.join(NodePath.dirname(process.execPath), "otter-mail-worker.mjs");
  }
  const here = NodeURL.fileURLToPath(import.meta.url);
  if (!here.endsWith(".ts")) {
    // The bundled server: `vp run build:bundle` writes the worker into the same dist folder.
    return NodePath.join(NodePath.dirname(here), "otter-mail-worker.mjs");
  }
  const builder = NodePath.join(NodePath.dirname(here), "worker", "buildMailWorker.ts");
  const { ensureDevMailWorker } = (await import(
    /* @vite-ignore */ NodeURL.pathToFileURL(builder).href
  )) as {
    ensureDevMailWorker: (cacheDir: string) => Promise<string>;
  };
  const serverRoot = NodePath.resolve(NodePath.dirname(here), "../../../");
  return ensureDevMailWorker(NodePath.join(serverRoot, "node_modules/.cache/otter-mail-worker"));
}

export class MailWorkerHost {
  private worker: NodeWorkerThreads.Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private readonly script: () => Promise<string>;
  private readonly data: MailWorkerData;
  private readonly onPush: (push: MailWorkerPush) => void;
  private readonly onExit: (error: Error) => void;

  constructor(options: {
    readonly script: () => Promise<string>;
    readonly data: MailWorkerData;
    readonly onPush: (push: MailWorkerPush) => void;
    readonly onExit: (error: Error) => void;
  }) {
    this.script = options.script;
    this.data = options.data;
    this.onPush = options.onPush;
    this.onExit = options.onExit;
  }

  private scriptPath: Promise<string> | null = null;

  private async ensureWorker(): Promise<NodeWorkerThreads.Worker> {
    if (this.worker) return this.worker;
    const path = await (this.scriptPath ??= this.script().catch((error: unknown) => {
      this.scriptPath = null;
      throw error;
    }));
    if (this.worker) return this.worker;
    const worker = new NodeWorkerThreads.Worker(path, {
      workerData: this.data,
      name: "otter-mail",
      resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    worker.on("message", (message: FromMailWorker) => {
      if (message.type !== "result") {
        this.onPush(message);
        return;
      }
      const call = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error !== undefined) call?.reject(new Error(message.error));
      else call?.resolve(message.result);
    });
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const call of this.pending.values()) call.reject(error);
      this.pending.clear();
      this.onExit(error);
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`Mail's worker exited (code ${code}).`)));
    // The server may exit while Mail idles; the worker must not hold it open.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  async call<K extends MailWorkerCall>(
    method: K,
    params: MailWorkerCalls[K]["params"],
  ): Promise<MailWorkerCalls[K]["result"]> {
    const worker = await this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.post(worker, { type: "call", id, method, params });
    });
  }

  /** A client's answer to a worker `request`. */
  reply(id: number, result: unknown, error: string | undefined): void {
    if (!this.worker) return;
    this.post(this.worker, {
      type: "reply",
      id,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    });
  }

  async terminate(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    await worker?.terminate();
  }

  private post(worker: NodeWorkerThreads.Worker, message: ToMailWorker): void {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port has none
    worker.postMessage(message);
  }
}
