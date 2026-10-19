import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ThreadDetailsControl } from "./ThreadDetailsControl";

it("keeps the row label and one chevron when used as a menu trigger", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <Menu>
          <MenuTrigger render={<ThreadDetailsControl part="select" />}>
            Run on this machine
          </MenuTrigger>
          <MenuPopup>
            <MenuItem>New worktree</MenuItem>
          </MenuPopup>
        </Menu>,
      );
    });
    const trigger = container.querySelector("button")!;
    expect(trigger.textContent).toBe("Run on this machine");
    expect(trigger.querySelectorAll('[data-slot="select-icon"]')).toHaveLength(1);
    const triggerControl = page.getByRole("button", { name: "Run on this machine", exact: true });
    await act(() => triggerControl.click());
    await expect.element(page.getByRole("menuitem", { name: "New worktree" })).toBeVisible();
    await act(() => userEvent.keyboard("{Escape}"));
    await expect
      .element(page.getByRole("menuitem", { name: "New worktree" }))
      .not.toBeInTheDocument();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
