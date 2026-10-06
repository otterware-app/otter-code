/**
 * Messages between the server's main thread (`../MailWorkerHost.ts`) and
 * Otter Mail's core in a worker thread (`mailWorker.ts`). Core is synchronous
 * SQLite plus MIME parsing, so it runs off the server's event loop; its fake
 * Gmail (the demo) patches the worker's `fetch`, not the server's.
 *
 * Plain types only: the server program imports this file, the worker bundle
 * does too, and nothing here may pull Mail's code into the server program.
 */

export interface MailWorkerData {
  /** Mail's own state directory (`<stateDir>/mail`, or `mail-demo` for the demo). */
  readonly home: string;
  /** AES-256-GCM key sealing Mail's secrets and Google tokens at rest (server secret store). */
  readonly sealKey: Uint8Array;
  /** The made-up mailboxes in front of a fake Gmail (`OTTER_MAIL_FAKE_DEMO=1`). */
  readonly demo: boolean;
  readonly relayUrl: string;
  readonly deviceName: string;
}

/** An agent calling Mail's tools: one per thread (Mail orders writes and keeps approvals per caller). */
export interface MailToolCaller {
  readonly key: string;
  readonly access: "read-only" | "safe" | "full-access";
}

export interface MailToolDescriptor {
  /** Mail's own name (`search_mail`); the MCP name adds a `mail_` prefix. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: { readonly type: "object"; readonly [key: string]: unknown };
  readonly readOnly: boolean;
  readonly permanent: boolean;
}

export interface MailHomeEntry {
  readonly id: string;
  readonly kind: "reply" | "draft";
  readonly title: string;
  readonly subtitle: string;
  readonly occurredAt: number;
  readonly priority: number;
  /** Mail's hash route (`/<account>/<label>/<messageId>`), for `/mail?at=`. */
  readonly at: string;
  readonly accountId: string;
  readonly threadId: string;
  readonly sender: { readonly name: string; readonly email: string };
  readonly labelIds: ReadonlyArray<string>;
}

/** What the host can ask of the worker; each answers one `result`. */
export interface MailWorkerCalls {
  /** Starts core (once); resolves with the channels it answers. */
  start: { params: undefined; result: { channels: ReadonlyArray<string> } };
  invoke: {
    params: { clientId: string | null; channel: string; params: unknown };
    result: unknown;
  };
  /** Needs no running core. */
  tools: { params: undefined; result: ReadonlyArray<MailToolDescriptor> };
  callTool: {
    params: { caller: MailToolCaller; name: string; args: Record<string, unknown> };
    result: { text: string; isError: boolean };
  };
  needsYou: { params: undefined; result: ReadonlyArray<MailHomeEntry> };
  /** Archives (`archive`) a needs-you thread, as the inbox's Archive would. */
  homeAction: { params: { itemId: string; actionId: string }; result: void };
}

export type MailWorkerCall = keyof MailWorkerCalls;

/** What core asks of a client (Mail's desktop asks its main process). */
export type MailClientRequestKind = "openExternal" | "pickFiles" | "openFile" | "saveFile";

export type ToMailWorker =
  | {
      readonly type: "call";
      readonly id: number;
      readonly method: MailWorkerCall;
      readonly params: unknown;
    }
  /** A client's answer to a `request`. */
  | {
      readonly type: "reply";
      readonly id: number;
      readonly result?: unknown;
      readonly error?: string;
    };

export type FromMailWorker =
  | {
      readonly type: "result";
      readonly id: number;
      readonly result?: unknown;
      readonly error?: string;
    }
  | { readonly type: "event"; readonly channel: string; readonly params?: unknown }
  | {
      readonly type: "request";
      readonly id: number;
      /** The client whose invoke caused it, or null for background work. */
      readonly clientId: string | null;
      readonly kind: MailClientRequestKind;
      readonly params?: unknown;
    }
  | {
      readonly type: "notify";
      readonly title: string;
      readonly subtitle?: string;
      readonly body?: string;
      readonly open?: { readonly accountId: string; readonly messageId: string };
    }
  | { readonly type: "unread"; readonly count: number }
  | {
      readonly type: "log";
      readonly level: "debug" | "info" | "warn" | "error";
      readonly scope: string;
      readonly message: string;
      readonly data?: string;
    };
