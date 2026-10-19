import { describe, expect, it, vi } from "vite-plus/test";

import { createWindowMaterialApplier, getWindowMaterialOptions } from "./WindowMaterial.ts";

function makeWindow() {
  return {
    getNativeWindowHandle: vi.fn(() => Buffer.alloc(8)),
    setVibrancy: vi.fn(),
    setBackgroundColor: vi.fn(),
  };
}

describe("desktop window material", () => {
  it("creates a native glass backing only on macOS", () => {
    const settings = { windowMaterial: "translucent", windowBlur: 64 } as const;
    expect(getWindowMaterialOptions("darwin", true, settings)).toEqual({
      backgroundColor: "#00000000",
      vibrancy: "under-window",
      visualEffectState: "followWindow",
    });
    expect(getWindowMaterialOptions("win32", true, settings)).toEqual({
      backgroundColor: "#181818",
    });
    expect(getWindowMaterialOptions("linux", false, settings)).toEqual({
      backgroundColor: "#ffffff",
    });
  });

  it("sets the native background blur and skips unrelated settings saves", () => {
    const window = makeWindow();
    const addon = { setBackgroundBlurRadius: vi.fn(() => true) };
    const load = vi.fn(() => addon);
    const apply = createWindowMaterialApplier(load);
    expect(apply(window, { windowMaterial: "translucent", windowBlur: 64 }, true)).toBe(true);
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(addon.setBackgroundBlurRadius).toHaveBeenLastCalledWith(
      window.getNativeWindowHandle(),
      64,
    );
    apply(window, { windowMaterial: "translucent", windowBlur: 64 }, true);
    expect(addon.setBackgroundBlurRadius).toHaveBeenCalledTimes(1);
    apply(window, { windowMaterial: "translucent", windowBlur: 12 }, true);
    expect(addon.setBackgroundBlurRadius).toHaveBeenLastCalledWith(
      window.getNativeWindowHandle(),
      12,
    );
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("restores a solid backing and removes native blur when glass is disabled", () => {
    const window = makeWindow();
    const addon = { setBackgroundBlurRadius: vi.fn(() => true) };
    const apply = createWindowMaterialApplier(() => addon);
    apply(window, { windowMaterial: "translucent", windowBlur: 64 }, true);
    apply(window, { windowMaterial: "solid", windowBlur: 64 }, false);
    expect(addon.setBackgroundBlurRadius).toHaveBeenLastCalledWith(
      window.getNativeWindowHandle(),
      0,
    );
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
  });

  it.each(["missing", "refused"] as const)(
    "falls back to native vibrancy when the addon is %s",
    (reason) => {
      const window = makeWindow();
      const apply = createWindowMaterialApplier(() =>
        reason === "missing" ? null : { setBackgroundBlurRadius: () => false },
      );
      const settings = { windowMaterial: "translucent", windowBlur: 32 } as const;
      expect(apply(window, settings, true)).toBe(false);
      expect(apply(window, settings, true)).toBe(false);
      expect(window.setVibrancy).toHaveBeenLastCalledWith("under-window");
    },
  );
});
