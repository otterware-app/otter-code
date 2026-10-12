import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import { defineSuiteContract } from "./contract.ts";

/**
 * Otter Mail on an Otterware server. Mail's own renderer runs in the web
 * client (a frame) and talks to Mail's core on the server through these:
 * `invoke` is its `desktopBridge.invoke(channel, params)`, `events` carries
 * core's pushes plus what core asks of the client (open a URL, pick files),
 * and `reply` answers those asks. Mail's channels and payloads are Mail's
 * (vendor/otter-mail), so they cross as opaque JSON; bytes travel as
 * `{ $bytes: base64 }` (`encodeMailBytes`/`decodeMailBytes`).
 */
export const SUITE_MAIL_METHODS = {
  invoke: "suite.mail.invoke",
  events: "suite.mail.events",
  reply: "suite.mail.reply",
} as const;

/** One client's mail session (a frame); core's asks go to the client that caused them. */
const ClientId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));

export class SuiteMailError extends Schema.TaggedError<SuiteMailError>()("SuiteMailError", {
  /** Mail's own message, shown by its renderer as it would on the desktop. */
  detail: Schema.String,
  channel: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return this.detail;
  }
}

export const SuiteMailInvokeInput = Schema.Struct({
  clientId: ClientId,
  channel: Schema.String.check(Schema.isMaxLength(200)),
  params: Schema.optional(Schema.Unknown),
});
export type SuiteMailInvokeInput = typeof SuiteMailInvokeInput.Type;

/** What core asks of the client that caused it (Mail's desktop asks its main process). */
export const SuiteMailClientRequestKind = Schema.Literals([
  "openExternal",
  "googleAuth",
  "microsoftAuth",
  "pickFiles",
  "openFile",
  "saveFile",
]);
export type SuiteMailClientRequestKind = typeof SuiteMailClientRequestKind.Type;

export const SuiteMailEvent = Schema.Union([
  /** Core is running; `channels` are the ones it answers (the frame answers the rest). */
  Schema.Struct({ type: Schema.Literal("ready"), channels: Schema.Array(Schema.String) }),
  /** Core could not start (shown in place of Mail). */
  Schema.Struct({ type: Schema.Literal("failed"), message: Schema.String }),
  /** A core broadcast (renderer: `desktopBridge.on(channel)`). */
  Schema.Struct({
    type: Schema.Literal("event"),
    channel: Schema.String,
    params: Schema.optional(Schema.Unknown),
  }),
  /** Core asks this client for something; answer with `suite.mail.reply`. */
  Schema.Struct({
    type: Schema.Literal("request"),
    id: Schema.Number,
    kind: SuiteMailClientRequestKind,
    params: Schema.optional(Schema.Unknown),
  }),
  /** The pending ask ended on the server (completed, cancelled, or timed out). */
  Schema.Struct({ type: Schema.Literal("requestCancelled"), id: Schema.Number }),
  /** A new-mail notification. */
  Schema.Struct({
    type: Schema.Literal("notify"),
    title: Schema.String,
    subtitle: Schema.optional(Schema.String),
    body: Schema.optional(Schema.String),
    open: Schema.optional(Schema.Struct({ accountId: Schema.String, messageId: Schema.String })),
  }),
  /** Unread mail in the inbox, for the rail badge. */
  Schema.Struct({ type: Schema.Literal("unread"), count: Schema.Number }),
]);
export type SuiteMailEvent = typeof SuiteMailEvent.Type;

const SuiteMailInvokeRpc = Rpc.make(SUITE_MAIL_METHODS.invoke, {
  payload: SuiteMailInvokeInput,
  success: Schema.Unknown,
  error: Schema.Union([SuiteMailError, EnvironmentAuthorizationError]),
});

const SuiteMailEventsRpc = Rpc.make(SUITE_MAIL_METHODS.events, {
  payload: Schema.Struct({ clientId: ClientId }),
  success: SuiteMailEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const SuiteMailReplyRpc = Rpc.make(SUITE_MAIL_METHODS.reply, {
  payload: Schema.Struct({
    clientId: ClientId,
    id: Schema.Number,
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.String),
  }),
  success: Schema.Void,
  error: EnvironmentAuthorizationError,
});

export const SuiteMailRpcGroup = RpcGroup.make(
  SuiteMailInvokeRpc,
  SuiteMailEventsRpc,
  SuiteMailReplyRpc,
);

export const SuiteMailContract = defineSuiteContract({
  group: SuiteMailRpcGroup,
  scopes: {
    [SUITE_MAIL_METHODS.invoke]: AuthOrchestrationOperateScope,
    [SUITE_MAIL_METHODS.events]: AuthOrchestrationReadScope,
    [SUITE_MAIL_METHODS.reply]: AuthOrchestrationOperateScope,
  },
});

// ── Bytes over JSON ──────────────────────────────────────────────────────────

/** How a `Uint8Array` crosses the JSON transport. */
export interface EncodedMailBytes {
  readonly $bytes: string;
}

const BASE64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const isEncodedBytes = (value: object): value is EncodedMailBytes =>
  Object.keys(value).length === 1 && typeof (value as { $bytes?: unknown }).$bytes === "string";

/** Replaces every `Uint8Array` in `value` with `{ $bytes: base64 }`, for the JSON transport. */
export function encodeMailBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: bytesToBase64(value) };
  if (Array.isArray(value))
    return value.map((entry) => (entry === undefined ? null : encodeMailBytes(entry)));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, encodeMailBytes(entry)]),
    );
  }
  return value;
}

/** Turns every `{ $bytes: base64 }` in `value` back into a `Uint8Array`. */
export function decodeMailBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeMailBytes);
  if (value !== null && typeof value === "object") {
    if (isEncodedBytes(value)) return base64ToBytes(value.$bytes);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, decodeMailBytes(entry)]),
    );
  }
  return value;
}
