/**
 * Small questions a calendar change may need before it runs: which occurrences of a recurring
 * event it applies to, and whether guests hear about it. Callers await the answer; null means
 * the user cancelled. `CalendarPromptHost` renders the open question.
 */
import type { CalendarChangeScope, CalendarSendUpdates } from "@t3tools/contracts";
import { create } from "zustand";

export interface PromptChoice<T extends string> {
  readonly value: T;
  readonly label: string;
}

export interface CalendarPrompt {
  readonly title: string;
  readonly description?: string;
  readonly choices: ReadonlyArray<PromptChoice<string>>;
  /** Focused when the dialog opens, so Enter picks it. */
  readonly defaultValue: string;
  readonly confirmLabel: string;
  readonly resolve: (value: string | null) => void;
}

export const useCalendarPrompt = create<{ readonly prompt: CalendarPrompt | null }>(() => ({
  prompt: null,
}));

function ask<T extends string>(prompt: Omit<CalendarPrompt, "resolve">): Promise<T | null> {
  // A new question replaces an unanswered one, which counts as cancelled.
  useCalendarPrompt.getState().prompt?.resolve(null);
  return new Promise((resolve) => {
    useCalendarPrompt.setState({
      prompt: {
        ...prompt,
        resolve: (value) => {
          useCalendarPrompt.setState({ prompt: null });
          resolve(value as T | null);
        },
      },
    });
  });
}

export function answerCalendarPrompt(value: string | null): void {
  useCalendarPrompt.getState().prompt?.resolve(value);
}

const SCOPE_TITLES = {
  move: "Move recurring event",
  save: "Save recurring event",
  delete: "Delete recurring event",
  respond: "Reply to recurring event",
} as const;

/**
 * "This event / This and following events / All events", like Google Calendar. Changing the
 * repeat rule itself only offers the last two; replies only offer this one or all.
 */
export function requestRecurringScope(
  action: keyof typeof SCOPE_TITLES,
  options: { readonly allowThis?: boolean } = {},
): Promise<CalendarChangeScope | null> {
  const allowThis = options.allowThis ?? true;
  const choices: PromptChoice<CalendarChangeScope>[] = [
    ...(allowThis ? [{ value: "this" as const, label: "This event" }] : []),
    ...(action === "respond"
      ? []
      : [{ value: "following" as const, label: "This and following events" }]),
    { value: "all", label: "All events" },
  ];
  return ask<CalendarChangeScope>({
    title: SCOPE_TITLES[action],
    choices,
    defaultValue: choices[0]!.value,
    confirmLabel: action === "delete" ? "Delete" : "OK",
  });
}

/** Whether to email guests about a change to an event they are invited to. */
export function requestSendUpdates(
  action: "save" | "delete",
): Promise<Exclude<CalendarSendUpdates, "externalOnly"> | null> {
  return ask<"all" | "none">({
    title: action === "delete" ? "Notify guests about the cancellation?" : "Notify guests?",
    description:
      action === "delete"
        ? "Guests get an email saying the event was cancelled."
        : "Guests get an email with the updated event.",
    choices: [
      { value: "all", label: "Send" },
      { value: "none", label: "Don't send" },
    ],
    defaultValue: "all",
    confirmLabel: "OK",
  });
}
