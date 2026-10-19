import "~/index.css";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { ComposerSurface } from "./ComposerSurface";

it("lays the context strip below the input with a gap and no overlapping seam", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <ComposerSurface.Shell contextStrip>
          <ComposerSurface.Host>Message</ComposerSurface.Host>
          <ComposerSurface.ContextStrip>Workspace</ComposerSurface.ContextStrip>
        </ComposerSurface.Shell>,
      );
    });

    const host = container.querySelector('[data-slot="composer-host"]')!;
    const strip = container.querySelector('[data-slot="composer-context-strip"]')!;
    const hostBounds = host.getBoundingClientRect();
    const stripBounds = strip.getBoundingClientRect();

    expect(hostBounds.height).toBeGreaterThan(0);
    expect(stripBounds.height).toBeGreaterThan(0);
    expect(stripBounds.top).toBeGreaterThan(hostBounds.bottom);
    expect(stripBounds.left).toBeCloseTo(hostBounds.left);
    expect(stripBounds.right).toBeCloseTo(hostBounds.right);
    expect(getComputedStyle(strip, "::before").content).toBe("none");
    expect(getComputedStyle(host, "::after").clipPath).toBe("none");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
