/**
 * Where the Drive page is looking. On desktop the page hosts drive.otterware.app
 * itself in a native WebContentsView and `openDriveUrl` steers it; in a browser Drive
 * cannot be embedded (its session cookies are SameSite=Lax, so a cross-site
 * frame is never signed in), so documents open in a new tab and the page shows
 * Otterware's own list and preview instead.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { create } from "zustand";

import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";

interface DriveViewState {
  /** A URL someone asked the view to show; the view loads it and clears it. */
  readonly requested: { readonly url: string; readonly id: number } | null;
  /** What the view shows now, from its navigation events. */
  readonly current: { readonly url: string; readonly title: string } | null;
  readonly request: (url: string) => void;
  readonly consume: (id: number) => void;
  readonly setCurrent: (current: { readonly url: string; readonly title: string }) => void;
}

let requestId = 0;

export const useDriveViewStore = create<DriveViewState>((set) => ({
  requested: null,
  current: null,
  request: (url) => set({ requested: { url, id: ++requestId } }),
  consume: (id) => set((state) => (state.requested?.id === id ? { requested: null } : state)),
  setCurrent: (current) => set({ current }),
}));

/** Opens a URL in the system browser (desktop) or a new tab (web). */
export function openDriveExternally(url: string): void {
  const api = readLocalApi();
  if (api) {
    void api.shell.openExternal(url).catch((error: unknown) => console.error(error));
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Steers the persistent desktop view; the caller navigates to /drive. */
export function openDriveUrl(url: string): void {
  if (isElectron) useDriveViewStore.getState().request(url);
  else openDriveExternally(url);
}

/**
 * Opens a Drive URL where Drive lives in this client: the desktop Drive view
 * (navigating to `/drive`), or a new browser tab on the web.
 */
export function useOpenDriveUrl(): (url: string) => void {
  const navigate = useNavigate();
  return useCallback(
    (url: string) => {
      if (!isElectron) {
        openDriveExternally(url);
        return;
      }
      openDriveUrl(url);
      void navigate({ to: "/drive" });
    },
    [navigate],
  );
}
