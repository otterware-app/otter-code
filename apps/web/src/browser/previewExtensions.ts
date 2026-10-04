/**
 * Chrome extensions in the desktop browser preview: the desktop bridge's
 * `previewExtensions`, the toolbar's pinned buttons, and hooks that keep
 * extensions and their buttons current.
 */
import type { DesktopPreviewExtension, DesktopPreviewExtensionAction } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";
import { readLocalApi } from "~/localApi";

/** `null` on the web build, and on desktop builds without extensions. */
export const previewExtensions =
  typeof window === "undefined" ? null : (window.desktopBridge?.previewExtensions ?? null);

export const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com/category/extensions";

interface PreviewExtensionsUiState {
  /** Extensions whose buttons sit on the toolbar, in order. */
  readonly pinned: ReadonlyArray<string>;
  /** Whether the toolbar shows the Extensions (puzzle) button. */
  readonly extensionsButton: boolean;
  /** Settings' developer mode: loading an extension from a folder. */
  readonly developerMode: boolean;
  readonly setPinned: (extensionId: string, pinned: boolean) => void;
  readonly setExtensionsButton: (shown: boolean) => void;
  readonly setDeveloperMode: (on: boolean) => void;
}

export const usePreviewExtensionsUi = create<PreviewExtensionsUiState>()(
  persist(
    (set) => ({
      pinned: [],
      extensionsButton: true,
      developerMode: false,
      setExtensionsButton: (extensionsButton) => set({ extensionsButton }),
      setDeveloperMode: (developerMode) => set({ developerMode }),
      setPinned: (extensionId, pinned) =>
        set((state) => ({
          pinned: pinned
            ? [...state.pinned.filter((id) => id !== extensionId), extensionId]
            : state.pinned.filter((id) => id !== extensionId),
        })),
    }),
    {
      name: "t3code:preview-extensions:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        pinned: state.pinned,
        extensionsButton: state.extensionsButton,
        developerMode: state.developerMode,
      }),
    },
  ),
);

/** What `read` returns, read again whenever extensions or their buttons change. */
function useWhenExtensionsChange<T>(read: (() => Promise<T>) | null, initial: T): T {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (!read || !previewExtensions) return;
    let current = true;
    const load = () =>
      void read().then(
        (next) => {
          if (current) setValue(next);
        },
        () => undefined,
      );
    load();
    const unsubscribe = previewExtensions.onChanged(load);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [read]);
  return value;
}

const listInstalled = previewExtensions ? () => previewExtensions.list() : null;

/** Every installed extension, on or off; `null` until read. */
export function useInstalledPreviewExtensions(): ReadonlyArray<DesktopPreviewExtension> | null {
  return useWhenExtensionsChange(listInstalled, null);
}

const NO_ACTIONS: ReadonlyArray<DesktopPreviewExtensionAction> = [];

/** The toolbar's buttons for the tab showing in `webContentsId`. */
export function usePreviewExtensionActions(
  webContentsId: number | null,
): ReadonlyArray<DesktopPreviewExtensionAction> {
  const read = useMemo(
    () =>
      previewExtensions && webContentsId !== null
        ? () => previewExtensions.actions(webContentsId)
        : null,
    [webContentsId],
  );
  return useWhenExtensionsChange(read, NO_ACTIONS);
}

/**
 * Pages extensions open go to the preview showing (the newest one asking);
 * with none showing, to the system browser.
 */
const openTabHandlers: Array<(url: string) => void> = [];
let listeningForTabs = false;

export function useOpenExtensionTabs(handler: ((url: string) => void) | null): void {
  useEffect(() => {
    if (!handler || !previewExtensions) return;
    if (!listeningForTabs) {
      listeningForTabs = true;
      previewExtensions.onOpenTab((url) => {
        const open = openTabHandlers.at(-1);
        if (open) open(url);
        else void readLocalApi()?.shell.openExternal(url);
      });
    }
    openTabHandlers.push(handler);
    return () => {
      const at = openTabHandlers.lastIndexOf(handler);
      if (at >= 0) openTabHandlers.splice(at, 1);
    };
  }, [handler]);
}
