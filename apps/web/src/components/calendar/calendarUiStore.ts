/**
 * The calendar page's transient UI: the selected event, its details popover, the editor panel,
 * and the dialogs (search, go to date, Google sign-in). Shortcuts, the palette, the sidebar and
 * the views all open things through here, so every entry point shows the same UI.
 */
import { pendingEventId } from "@t3tools/client-runtime/calendar/optimistic";
import type { CalendarEventInstance } from "@t3tools/contracts";
import { create } from "zustand";

/** A new event before it is saved, shown in the grid while the editor is open. */
export interface EventDraft {
  /** The pending event id the draft shows under (and the created event until it arrives). */
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly allDay: boolean;
  readonly calendarId: string | null;
  readonly title?: string;
}

export type EditorTarget =
  | { readonly mode: "create"; readonly draft: EventDraft }
  | {
      readonly mode: "edit";
      readonly calendarId: string;
      readonly eventId: string;
      /** The instance as shown when the editor opened (for the recurring-scope prompt). */
      readonly instance: CalendarEventInstance;
    };

/** What opens the editor; a new draft gets its id here. */
export type EditorRequest =
  | Exclude<EditorTarget, { readonly mode: "create" }>
  | { readonly mode: "create"; readonly draft: Omit<EventDraft, "id"> };

export type CalendarDialog = "search" | "goToDate" | null;

interface CalendarUiState {
  /** `calendarEventKey` of the event the popover or editor shows. */
  readonly selectedKey: string | null;
  readonly popover: {
    readonly instance: CalendarEventInstance;
    readonly anchor: Element | null;
  } | null;
  readonly editor: EditorTarget | null;
  readonly dialog: CalendarDialog;
  /** An open Google sign-in; `loginHint` preselects the account when reconnecting. */
  readonly googleConnect: { readonly loginHint?: string } | null;
  readonly openPopover: (instance: CalendarEventInstance, anchor: Element | null) => void;
  readonly closePopover: () => void;
  readonly openEditor: (request: EditorRequest) => void;
  /** The draft was dragged or resized in the grid. */
  readonly moveDraft: (range: Pick<EventDraft, "start" | "end" | "allDay">) => void;
  readonly closeEditor: () => void;
  readonly setDialog: (dialog: CalendarDialog) => void;
  readonly openGoogleConnect: (loginHint?: string) => void;
  readonly closeGoogleConnect: () => void;
}

function keyOf(instance: { readonly calendarId: string; readonly eventId: string }) {
  return `${instance.calendarId}/${instance.eventId}`;
}

export const useCalendarUi = create<CalendarUiState>((set) => ({
  selectedKey: null,
  popover: null,
  editor: null,
  dialog: null,
  googleConnect: null,
  openPopover: (instance, anchor) =>
    set({ popover: { instance, anchor }, selectedKey: keyOf(instance) }),
  closePopover: () =>
    set((state) => ({
      popover: null,
      selectedKey: state.editor?.mode === "edit" ? keyOf(state.editor) : null,
    })),
  openEditor: (request) =>
    set({
      editor:
        request.mode === "create"
          ? { mode: "create", draft: { ...request.draft, id: pendingEventId() } }
          : request,
      popover: null,
      selectedKey: request.mode === "edit" ? keyOf(request) : null,
    }),
  moveDraft: (range) =>
    set((state) =>
      state.editor?.mode === "create"
        ? { editor: { mode: "create", draft: { ...state.editor.draft, ...range } } }
        : state,
    ),
  closeEditor: () => set({ editor: null, selectedKey: null }),
  setDialog: (dialog) => set({ dialog }),
  openGoogleConnect: (loginHint) =>
    set({ googleConnect: loginHint === undefined ? {} : { loginHint } }),
  closeGoogleConnect: () => set({ googleConnect: null }),
}));

/** Read at event time, for handlers that must not subscribe. */
export function readCalendarUi() {
  return useCalendarUi.getState();
}
