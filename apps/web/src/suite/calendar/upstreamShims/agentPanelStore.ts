/**
 * `../../agentPanelStore` for the vendored calendar page (a manifest import remap). Otter
 * Calendar describes what the user sees to its own agent panel; Otterware keeps that text for
 * the shared side chat, which `CalendarSuitePage` publishes with `useSuitePageContext`.
 */
import { useEffect } from "react";
import { create } from "zustand";

export const useCalendarAgentContext = create<{ readonly text: string | null }>(() => ({
  text: null,
}));

export function useAgentPageContext(context: string | null): void {
  useEffect(() => {
    useCalendarAgentContext.setState({ text: context });
    return () => {
      if (useCalendarAgentContext.getState().text === context) {
        useCalendarAgentContext.setState({ text: null });
      }
    };
  }, [context]);
}
