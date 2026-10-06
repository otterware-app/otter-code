/**
 * `../../state/server` for the vendored calendar components (a manifest import remap): the same
 * module, with the calendar's default shortcuts added to the keybindings they resolve.
 */
import { Atom } from "effect/reactivity";

import { primaryServerKeybindingsAtom as serverKeybindingsAtom } from "../../../state/server";
import { withCalendarKeybindings } from "../calendarKeybindings";

export * from "../../../state/server";

export const primaryServerKeybindingsAtom = Atom.make((get) =>
  withCalendarKeybindings(get(serverKeybindingsAtom)),
).pipe(Atom.withLabel("web-calendar-keybindings"));
