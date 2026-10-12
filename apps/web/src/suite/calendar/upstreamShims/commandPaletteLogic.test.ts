import { describe, expect, it } from "vite-plus/test";

import { type CommandPaletteGroup, toPaletteGroups } from "./commandPaletteLogic";

describe("Calendar palette adaptation", () => {
  it("offers calendar visibility commands only while searching and awaits their actions", async () => {
    let visible = true;
    const groups: ReadonlyArray<CommandPaletteGroup> = [
      { value: "calendar", label: "Calendar", items: [] },
      {
        value: "calendars",
        label: "Calendars",
        searchOnly: true,
        items: [
          {
            kind: "action",
            value: "calendar:toggle:work",
            title: "Hide Work",
            searchTerms: ["Work"],
            icon: null,
            run: () => {
              visible = false;
            },
          },
        ],
      },
    ];
    expect(toPaletteGroups(groups, "  ").map((group) => group.value)).toEqual(["calendar"]);
    const searched = toPaletteGroups(groups, "Work");
    expect(searched.map((group) => group.value)).toEqual(["calendar", "calendars"]);
    const toggle = searched[1]!.items[0]!;
    if (toggle.kind !== "action") throw new Error("Expected a visibility action");
    await toggle.run();
    expect(visible).toBe(false);
  });
});
