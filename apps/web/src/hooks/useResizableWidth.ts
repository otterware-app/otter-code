import * as Schema from "effect/Schema";
import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useRef, useState } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";
import { useResizeDrag } from "./useResizeDrag";

const WidthSchema = Schema.Finite;

/** The host must size itself from this custom property. */
export const RESIZABLE_WIDTH_PROPERTY = "--resizable-width";

export interface UseResizableWidthOptions {
  readonly storageKey: string;
  /**
   * Shared key for a panel whose width is stored per context (such as per
   * thread): a context without its own width starts at the last width dragged
   * anywhere, and every drag updates it.
   */
  readonly fallbackStorageKey?: string | undefined;
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly edge: "left" | "right";
}

export interface ResizableWidthHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
}

/** Persist on drag end to avoid a storage write on every animation frame. */
export function useResizableWidth(options: UseResizableWidthOptions): {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
} {
  const { storageKey, fallbackStorageKey, defaultWidth, minWidth, maxWidth, edge } = options;

  const clamp = (value: number): number => {
    if (!Number.isFinite(value)) return defaultWidth;
    return Math.max(minWidth, Math.min(maxWidth, value));
  };

  const readWidth = () => {
    if (typeof window === "undefined") return defaultWidth;
    try {
      const stored =
        getLocalStorageItem(storageKey, WidthSchema) ??
        (fallbackStorageKey ? getLocalStorageItem(fallbackStorageKey, WidthSchema) : null);
      return clamp(stored ?? defaultWidth);
    } catch (error) {
      console.error("Could not read persisted panel width.", error);
      return defaultWidth;
    }
  };
  const [widthState, setWidthState] = useState(() => ({ storageKey, width: readWidth() }));
  if (widthState.storageKey !== storageKey) {
    setWidthState({ storageKey, width: readWidth() });
  }

  const clampedWidth = clamp(widthState.width);
  const latestOptions = useRef({ clamp, storageKey, fallbackStorageKey, width: clampedWidth });
  useLayoutEffect(() => {
    latestOptions.current = { clamp, storageKey, fallbackStorageKey, width: clampedWidth };
  }, [clamp, clampedWidth, storageKey, fallbackStorageKey]);

  const { refresh, ...handlers } = useResizeDrag<HTMLElement>((event) => {
    const host = event.currentTarget.parentElement;
    // Disable drag transitions through transition-property; the host renders transition-duration.
    host?.style.setProperty("transition-property", "none");
    return {
      width: clampedWidth,
      edge,
      resize(value) {
        const nextWidth = latestOptions.current.clamp(value);
        host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${nextWidth}px`);
        return nextWidth;
      },
      finish(finalWidth) {
        setWidthState({ storageKey, width: finalWidth });
        try {
          const latest = latestOptions.current;
          setLocalStorageItem(latest.storageKey, finalWidth, WidthSchema);
          if (latest.fallbackStorageKey)
            setLocalStorageItem(latest.fallbackStorageKey, finalWidth, WidthSchema);
        } catch (error) {
          console.error("Could not persist panel width.", error);
        }
      },
      cleanup(committed) {
        host?.style.removeProperty("transition-property");
        if (!committed) {
          host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${latestOptions.current.width}px`);
        }
      },
    };
  }, storageKey);

  // Mid-drag bound changes rewrite committed width; restore the live pointer position.
  useLayoutEffect(refresh, [clamp, clampedWidth, refresh]);

  return { width: clampedWidth, handlers };
}
