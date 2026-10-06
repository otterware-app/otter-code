/**
 * Otter Calendar's default shortcuts (single keys like `t`, `w`, `c`). They apply on the
 * calendar page only: the vendored page resolves shortcuts through `upstreamShims/serverState`,
 * which adds these to the server's keybindings. They never join the server's defaults, which
 * are written into the `keybindings.json` the shared Otter Code home also serves plain Otter
 * Code. A user rule for a calendar command (in `keybindings.json`) replaces its defaults.
 */
import type { KeybindingRule, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { compileResolvedKeybindingRule } from "@t3tools/shared/keybindings";

export const CALENDAR_DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "t", command: "calendar.today", when: "!editableFocus" },
  { key: "j", command: "calendar.next", when: "!editableFocus" },
  { key: "n", command: "calendar.next", when: "!editableFocus" },
  { key: "arrowright", command: "calendar.next", when: "!editableFocus" },
  { key: "k", command: "calendar.previous", when: "!editableFocus" },
  { key: "p", command: "calendar.previous", when: "!editableFocus" },
  { key: "arrowleft", command: "calendar.previous", when: "!editableFocus" },
  { key: "d", command: "calendar.view.day", when: "!editableFocus" },
  { key: "w", command: "calendar.view.week", when: "!editableFocus" },
  { key: "m", command: "calendar.view.month", when: "!editableFocus" },
  { key: "a", command: "calendar.view.agenda", when: "!editableFocus" },
  { key: "x", command: "calendar.view.custom", when: "!editableFocus" },
  { key: "c", command: "calendar.create", when: "!editableFocus" },
  { key: "mod+n", command: "calendar.create", when: "!editableFocus" },
  { key: "/", command: "calendar.search", when: "!editableFocus" },
  { key: "g", command: "calendar.goToDate", when: "!editableFocus" },
  { key: "mod+z", command: "calendar.undo", when: "!editableFocus" },
  { key: "mod+shift+z", command: "calendar.redo", when: "!editableFocus" },
];

const RESOLVED_CALENDAR_DEFAULTS = CALENDAR_DEFAULT_KEYBINDINGS.flatMap((rule) => {
  const resolved = compileResolvedKeybindingRule(rule);
  return resolved === null ? [] : [resolved];
});

/** The server's keybindings plus the calendar defaults for commands the user did not bind. */
export function withCalendarKeybindings(
  keybindings: ResolvedKeybindingsConfig,
): ResolvedKeybindingsConfig {
  const bound = new Set(keybindings.map((binding) => binding.command));
  const defaults = RESOLVED_CALENDAR_DEFAULTS.filter((binding) => !bound.has(binding.command));
  // Earlier rules lose to later ones, so user rules (and Otter Code's) keep their keys.
  return defaults.length === 0 ? keybindings : [...defaults, ...keybindings];
}
