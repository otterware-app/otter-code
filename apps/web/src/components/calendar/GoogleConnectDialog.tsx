/**
 * Connecting (or reconnecting) a Google account. The environment runs the OAuth flow and
 * listens on its own loopback port, so where the browser runs decides how Google's redirect
 * gets back:
 * - environment on this machine: open the page, the environment's listener finishes;
 * - desktop app with a remote environment: the desktop catches the redirect on the same port
 *   and we hand it over with `connectComplete`;
 * - any other browser: the redirect lands on a page that cannot load; the user pastes its
 *   address here.
 * Closing the dialog ends the stream, which cancels the flow.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GoogleConnectState } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { CircleCheckIcon, ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { calendarEnvironment } from "../../state/calendar";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { useCalendarUi } from "./calendarUiStore";

type ReturnMode = "local" | "desktop" | "paste";

function errorCode(cause: Cause.Cause<unknown>): { code: string | null; message: string } {
  const error = Cause.squash(cause);
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "CalendarError" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return {
      code: error.code,
      message: "detail" in error && typeof error.detail === "string" ? error.detail : error.code,
    };
  }
  return {
    code: null,
    message: error instanceof Error && error.message ? error.message : "Sign-in could not start.",
  };
}

function PasteCallback({
  environmentId,
  flowId,
  onError,
}: {
  environmentId: EnvironmentId;
  flowId: string;
  onError: (message: string | null) => void;
}) {
  const inputId = useId();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const complete = useAtomCommand(calendarEnvironment.googleConnectComplete, {
    reportFailure: false,
  });
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const callbackUrl = value.trim();
        if (!callbackUrl) return;
        setPending(true);
        const result = await complete({ environmentId, input: { flowId, callbackUrl } });
        setPending(false);
        if (result._tag === "Success") {
          onError(null);
          return;
        }
        const { code, message } = errorCode(result.cause);
        onError(
          code === "invalid"
            ? "That address is not from this sign-in. Copy the whole address of the page Google sent you to."
            : code === "not_found"
              ? "This sign-in ended. Start again."
              : message,
        );
      }}
    >
      <label htmlFor={inputId} className="text-xs text-muted-foreground">
        After approving, your browser shows a page that can't load (127.0.0.1). Copy its full
        address and paste it here.
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          placeholder="http://127.0.0.1:…/?code=…"
          value={value}
          maxLength={16_384}
          disabled={pending}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={pending || !value.trim()}>
          Connect
        </Button>
      </div>
    </form>
  );
}

function ConnectFlow({
  environmentId,
  loginHint,
  onClose,
}: {
  environmentId: EnvironmentId;
  loginHint: string | undefined;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0);
  const result = useAtomValue(
    calendarEnvironment.googleConnect({
      environmentId,
      input: { attempt, ...(loginHint === undefined ? {} : { loginHint }) },
    }),
  );
  const state: GoogleConnectState | null = Option.getOrNull(AsyncResult.value(result));
  const streamError = result._tag === "Failure" ? errorCode(result.cause) : null;
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const local = httpBaseUrl !== null && isLoopbackHost(new URL(httpBaseUrl).hostname);
  const [desktopFailed, setDesktopFailed] = useState<string | null>(null);
  const mode: ReturnMode = local
    ? "local"
    : window.desktopBridge?.receiveGoogleAuthCallback !== undefined && desktopFailed === null
      ? "desktop"
      : "paste";
  const [message, setMessage] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const complete = useAtomCommand(calendarEnvironment.googleConnectComplete, {
    reportFailure: false,
  });
  const waiting = state?._tag === "waiting" ? state : null;
  const handled = useRef<string | null>(null);

  // The desktop app opens the page itself and catches the redirect; on this machine's
  // environment (in the desktop app) opening the page is enough. Web browsers open it from the
  // button, since a page opened without a click is blocked.
  const flowId = waiting?.flowId ?? null;
  const authorizationUrl = waiting?.authorizationUrl ?? null;
  useEffect(() => {
    if (flowId === null || authorizationUrl === null || handled.current === flowId) return;
    const receiveCallback = window.desktopBridge?.receiveGoogleAuthCallback;
    if (mode === "desktop" && receiveCallback !== undefined) {
      handled.current = flowId;
      receiveCallback(authorizationUrl).then(
        async (callbackUrl) => {
          const completed = await complete({ environmentId, input: { flowId, callbackUrl } });
          if (completed._tag === "Failure") setMessage(errorCode(completed.cause).message);
        },
        (error: unknown) =>
          setDesktopFailed(
            error instanceof Error && error.message
              ? error.message
              : "Could not receive the sign-in on this computer.",
          ),
      );
    } else if (mode === "local" && isElectron) {
      handled.current = flowId;
      void ensureLocalApi().shell.openExternal(authorizationUrl);
    }
  }, [authorizationUrl, complete, environmentId, flowId, mode]);

  // Stop the desktop's listener when the flow moves on or the dialog closes.
  useEffect(() => {
    if (mode !== "desktop" || authorizationUrl === null) return;
    return () => {
      void window.desktopBridge
        ?.cancelGoogleAuthCallback?.(authorizationUrl)
        .catch(() => undefined);
    };
  }, [authorizationUrl, mode]);

  useEffect(() => {
    if (state?._tag !== "succeeded") return;
    toastManager.add({ type: "success", title: `Connected ${state.email}`, timeout: 3_000 });
    onClose();
  }, [onClose, state]);

  const retry = () => {
    handled.current = null;
    setMessage(null);
    setDesktopFailed(null);
    setAttempt((value) => value + 1);
  };
  const openPage = () => {
    if (waiting !== null) void ensureLocalApi().shell.openExternal(waiting.authorizationUrl);
  };

  let body: ReactNode;
  let footer: ReactNode = (
    <Button variant="ghost" onClick={onClose}>
      Cancel
    </Button>
  );
  if (streamError !== null) {
    const notConfigured = streamError.code === "not_configured";
    body = (
      <p className="flex items-start gap-2 text-sm text-foreground">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        {notConfigured
          ? "Google sign-in is not set up on this environment yet. Add a Google OAuth client in Calendar settings."
          : streamError.message}
      </p>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {notConfigured ? (
          <Button
            onClick={() => {
              onClose();
              void navigate({ to: "/settings/calendar" });
            }}
          >
            Open Calendar settings
          </Button>
        ) : (
          <Button onClick={retry}>Try again</Button>
        )}
      </>
    );
  } else if (state === null) {
    body = <p className="text-sm text-muted-foreground">Preparing sign-in…</p>;
  } else if (state._tag === "failed") {
    body = (
      <p className="flex items-start gap-2 text-sm text-foreground">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        {state.message}
      </p>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button onClick={retry}>Try again</Button>
      </>
    );
  } else if (state._tag === "exchanging") {
    body = (
      <p className="text-sm text-muted-foreground">Finishing sign-in and loading calendars…</p>
    );
  } else if (state._tag === "succeeded") {
    body = (
      <p className="flex items-center gap-2 text-sm text-foreground">
        <CircleCheckIcon className="size-4 text-success" aria-hidden />
        Connected {state.email}.
      </p>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {mode === "desktop"
            ? "Finish signing in in your browser. This window picks it up when you're done."
            : mode === "local" && isElectron
              ? "Finish signing in in your browser, then come back here."
              : "Sign in with Google in a new tab and allow access to your calendars."}
        </p>
        {desktopFailed ? <p className="text-xs text-warning-foreground">{desktopFailed}</p> : null}
        {mode === "paste" ? (
          <PasteCallback environmentId={environmentId} flowId={state.flowId} onError={setMessage} />
        ) : mode === "local" ? (
          showPaste ? (
            <PasteCallback
              environmentId={environmentId}
              flowId={state.flowId}
              onError={setMessage}
            />
          ) : (
            <div>
              <Button size="xs" variant="ghost-muted" onClick={() => setShowPaste(true)}>
                Browser didn't come back? Paste the address
              </Button>
            </div>
          )
        ) : null}
        {message ? <p className="text-xs text-destructive-foreground">{message}</p> : null}
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {mode === "desktop" ? null : (
          <Button
            variant={mode === "local" && isElectron ? "outline" : "default"}
            onClick={openPage}
          >
            {mode === "local" && isElectron ? "Open again" : "Open Google sign-in"}
            <ExternalLinkIcon />
          </Button>
        )}
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {loginHint ? "Reconnect Google account" : "Connect a Google account"}
        </DialogTitle>
        <DialogDescription>
          {loginHint
            ? `Sign in again as ${loginHint} so its calendars keep syncing.`
            : "Its calendars show up next to your other accounts."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>{body}</DialogPanel>
      <DialogFooter>{footer}</DialogFooter>
    </>
  );
}

/** The Google sign-in dialog; open it with `useCalendarUi().openGoogleConnect`. */
export function GoogleConnectDialog({ environmentId }: { environmentId: EnvironmentId | null }) {
  const googleConnect = useCalendarUi((state) => state.googleConnect);
  const close = useCalendarUi((state) => state.closeGoogleConnect);
  const open = googleConnect !== null && environmentId !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPopup className="max-w-md" data-google-connect="">
        {open ? (
          <ConnectFlow
            environmentId={environmentId}
            loginHint={googleConnect.loginHint}
            onClose={close}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
