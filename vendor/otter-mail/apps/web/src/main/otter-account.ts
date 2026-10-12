import { useEffect, useState } from "react";
import {
  OTTER_ACCOUNT_STATE_CHANNEL,
  type OtterAccountState,
  type OtterDevice,
} from "@otter-mail/contracts";
import type { AgentTokens } from "@otter-mail/contracts/agent-tokens";

/**
 * The Otter account (sign-in to sync accounts across Macs and get mail by
 * push). The main process owns the state and pushes changes on `otter:state`.
 */

const invoke = <T>(channel: string, params?: unknown) =>
  window.desktopBridge.invoke<T>(channel, params);

export const otterApi = {
  getState: () => invoke<OtterAccountState>("otter:getState"),
  /** "Sign in with Google" (the desktop opens the browser; the web redirects). Null: cancelled. */
  signIn: () => invoke<OtterAccountState | null>("otter:signIn"),
  cancelSignIn: () => invoke<void>("otter:cancelSignIn"),
  signOut: () => invoke<OtterAccountState>("otter:signOut"),
  listDevices: () => invoke<OtterDevice[]>("otter:listDevices"),
  signOutDevice: (token: string) => invoke<void>("otter:signOutDevice", { token }),
  /** Deletes the Otter account on the relay; this Mac's accounts and mail stay. */
  deleteAccount: () => invoke<OtterAccountState>("otter:deleteAccount"),
  /** Tokens agents elsewhere (Hermes) reach the account's projects with, at the relay's MCP server. */
  listAgentTokens: () => invoke<AgentTokens>("otter:listAgentTokens"),
  /** Answers the token, this once. */
  createAgentToken: (name: string) => invoke<string>("otter:createAgentToken", { name }),
  deleteAgentToken: (id: string) => invoke<void>("otter:deleteAgentToken", { id }),
};

/** Live Otter account state; null until loaded. */
export function useOtterAccount(): OtterAccountState | null {
  const [state, setState] = useState<OtterAccountState | null>(null);
  useEffect(() => {
    let alive = true;
    void otterApi.getState().then((next) => {
      if (alive) setState(next);
    });
    const off = window.desktopBridge.on(OTTER_ACCOUNT_STATE_CHANNEL, (next) =>
      setState(next as OtterAccountState),
    );
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}
