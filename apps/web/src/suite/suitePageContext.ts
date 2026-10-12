/**
 * What the user is looking at on a module page, published for the side chat
 * to send along as context. A module page calls `useSuitePageContext(...)`
 * with its current selection; the side chat reads `useCurrentSuitePageContext()`.
 */
import { useEffect } from "react";
import { create } from "zustand";

/** One thing on screen the agent can be told about, e.g. a mail thread or an event. */
export interface SuitePageRef {
  /** Module-defined, e.g. `mail.thread`, `calendar.event`, `drive.file`. */
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  /** A URL or route the agent or user can follow back to it. */
  readonly href?: string;
}

export interface SuitePageContext {
  readonly module: string;
  readonly title: string;
  readonly refs: ReadonlyArray<SuitePageRef>;
}

interface SuitePageContextState {
  readonly context: SuitePageContext | null;
  readonly publish: (context: SuitePageContext | null) => void;
}

const useSuitePageContextStore = create<SuitePageContextState>((set) => ({
  context: null,
  publish: (context) => set({ context }),
}));

/** Publishes `context` while the calling page is mounted; pass null to clear it. */
export function useSuitePageContext(context: SuitePageContext | null): void {
  const publish = useSuitePageContextStore((state) => state.publish);
  // Compared by value, so pages can build the object inline on every render.
  const key = context === null ? null : JSON.stringify(context);
  useEffect(() => {
    const published: SuitePageContext | null = key === null ? null : JSON.parse(key);
    publish(published);
    return () => {
      if (useSuitePageContextStore.getState().context === published) publish(null);
    };
  }, [key, publish]);
}

export function useCurrentSuitePageContext(): SuitePageContext | null {
  return useSuitePageContextStore((state) => state.context);
}
