/**
 * The parent page's side of the Mail frame: `window.__otterMailHost`, which
 * the frame's `desktopBridge` (frame/entry.ts) is built on. It carries Mail's
 * invokes to the environment over `suite.mail.*` and the environment's pushes
 * back. Values cross as JSON with bytes as `{ $bytes }`; the frame encodes
 * and decodes them in its own realm, so typed arrays never cross documents.
 */
import { request, subscribe, type EnvironmentRpcInput } from "@t3tools/client-runtime/rpc";
import type { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentCommand,
  createEnvironmentSubscriptionAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { SUITE_MAIL_METHODS, type SuiteMailEvent } from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../../connection/runtime";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";

/** What the frame finds on `window.parent.__otterMailHost`. */
export interface OtterMailHost {
  invoke(channel: string, params: unknown): Promise<unknown>;
  /** Every event for this frame; returns an unsubscribe function. */
  listen(listener: (event: SuiteMailEvent) => void): () => void;
  reply(id: number, result: unknown, error?: string): void;
  openExternal(url: string): Promise<void>;
  receiveGoogleAuthCallback?: (authorizationUrl: string) => Promise<string>;
  cancelGoogleAuthCallback?: (authorizationUrl: string) => Promise<void>;
  /** The frame's route changed (Mail's hash), for the URL and the side chat. */
  navigated(path: string): void;
  /** What the open conversation is, when the frame knows. */
  showing(conversation: { readonly title: string; readonly path: string } | null): void;
}

declare global {
  interface Window {
    __otterMailHost?: OtterMailHost;
  }
}

const invokeCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "suite:mail:invoke",
  execute: (input: EnvironmentRpcInput<typeof SUITE_MAIL_METHODS.invoke>) =>
    request(SUITE_MAIL_METHODS.invoke, input),
});

const replyCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "suite:mail:reply",
  execute: (input: EnvironmentRpcInput<typeof SUITE_MAIL_METHODS.reply>) =>
    request(SUITE_MAIL_METHODS.reply, input),
});

/**
 * `suite.mail.events` is a stream RPC the client runtime's typed subscription
 * list doesn't name (suite RPCs live in their own group); it follows the
 * environment's sessions like the others do.
 */
const subscribeMailEvents = subscribe as unknown as (
  tag: typeof SUITE_MAIL_METHODS.events,
  input: { readonly clientId: string },
) => Stream.Stream<SuiteMailEvent, unknown, EnvironmentSupervisor.EnvironmentSupervisor>;

/** Each frame's listener, by its client id; the subscription atom feeds them event by event. */
const listeners = new Map<string, (event: SuiteMailEvent) => void>();

const mailEventsAtom = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "suite:mail:events",
  idleTtlMs: 0,
  subscribe: (input: { readonly clientId: string }) =>
    subscribeMailEvents(SUITE_MAIL_METHODS.events, input).pipe(
      Stream.tap((event) => Effect.sync(() => listeners.get(input.clientId)?.(event))),
    ),
});

function failureMessage(cause: unknown): string {
  if (cause !== null && typeof cause === "object") {
    const detail = (cause as { detail?: unknown; message?: unknown }).detail;
    if (typeof detail === "string") return detail;
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(cause);
}

export function openExternalUrl(url: string): Promise<void> {
  const bridge = window.desktopBridge;
  if (bridge) return bridge.openExternal(url).then(() => undefined);
  window.open(url, "_blank", "noopener");
  return Promise.resolve();
}

export type OtterMailHostHandle = OtterMailHost & {
  readonly clientId: string;
  readonly dispose: () => void;
};

export async function invokeMailAccount(
  environmentId: EnvironmentId,
  token: string | null,
): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    invokeCommand,
    {
      environmentId,
      input: {
        clientId: "otterware-account",
        channel: "otterware:accountSession",
        params: { token },
      },
    },
    { reportFailure: false },
  );
  if (result._tag !== "Success") throw new Error(failureMessage(squashAtomCommandFailure(result)));
}

/** A host for one frame, talking to `environmentId`. `dispose` ends its subscription. */
export function createOtterMailHost(options: {
  readonly environmentId: EnvironmentId;
  readonly account?: {
    readonly available: () => boolean;
    readonly ensure: () => Promise<void>;
    readonly signOut: () => Promise<void>;
  };
  readonly onNavigate: (path: string) => void;
  readonly onShowing: (
    conversation: { readonly title: string; readonly path: string } | null,
  ) => void;
}): OtterMailHostHandle {
  const clientId = randomUUID();
  const frameListeners = new Set<(event: SuiteMailEvent) => void>();
  const desktop = window.desktopBridge;
  const googleRequests = new Set<string>();
  const googleRequestIds = new Set<number>();
  listeners.set(clientId, (event) => {
    if (event.type === "request" && event.kind === "googleAuth") googleRequestIds.add(event.id);
    if (event.type === "requestCancelled") googleRequestIds.delete(event.id);
    for (const listener of frameListeners) listener(event);
  });
  const unmount = appAtomRegistry.mount(
    mailEventsAtom({ environmentId: options.environmentId, input: { clientId } }),
  );

  return {
    clientId,
    async invoke(channel, params) {
      if (options.account?.available() && channel === "otter:signIn") {
        await options.account.ensure();
        channel = "otter:getState";
      } else if (options.account?.available() && channel === "otter:signOut") {
        await options.account.signOut();
        channel = "otter:getState";
      }
      const result = await runAtomCommand(
        appAtomRegistry,
        invokeCommand,
        {
          environmentId: options.environmentId,
          input: { clientId, channel, ...(params === undefined ? {} : { params }) },
        },
        // Mail shows its own errors (toasts, inline); the console would only repeat them.
        { reportFailure: false },
      );
      if (result._tag === "Success") return result.value;
      throw new Error(failureMessage(squashAtomCommandFailure(result)));
    },
    listen(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    reply(id, result, error) {
      googleRequestIds.delete(id);
      void runAtomCommand(appAtomRegistry, replyCommand, {
        environmentId: options.environmentId,
        input: {
          clientId,
          id,
          ...(result === undefined ? {} : { result }),
          ...(error === undefined ? {} : { error }),
        },
      });
    },
    openExternal: openExternalUrl,
    ...(desktop?.receiveGoogleAuthCallback
      ? {
          async receiveGoogleAuthCallback(authorizationUrl: string) {
            googleRequests.add(authorizationUrl);
            try {
              return await desktop.receiveGoogleAuthCallback!(authorizationUrl);
            } finally {
              googleRequests.delete(authorizationUrl);
            }
          },
          cancelGoogleAuthCallback: (authorizationUrl: string) =>
            desktop.cancelGoogleAuthCallback?.(authorizationUrl) ?? Promise.resolve(),
        }
      : {}),
    navigated: options.onNavigate,
    showing: options.onShowing,
    dispose() {
      // End the frame's prompt first so a rejected native listener cannot reopen consent
      // after navigation away from Mail. This also clears pending web-only prompts.
      for (const id of googleRequestIds) {
        for (const listener of frameListeners) listener({ type: "requestCancelled", id });
      }
      googleRequestIds.clear();
      for (const url of googleRequests)
        void desktop?.cancelGoogleAuthCallback?.(url).catch(() => {});
      googleRequests.clear();
      unmount();
      listeners.delete(clientId);
      frameListeners.clear();
    },
  };
}
