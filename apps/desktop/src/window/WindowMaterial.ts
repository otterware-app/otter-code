import type { ClientSettings } from "@t3tools/contracts";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

const MAC_WINDOW_VIBRANCY = "under-window";

export interface WindowMaterialAddon {
  readonly setBackgroundBlurRadius: (nativeWindowHandle: Buffer, radius: number) => boolean;
}

type MaterialWindow = Pick<
  BrowserWindow,
  "getNativeWindowHandle" | "setVibrancy" | "setBackgroundColor"
>;
type WindowMaterialSettings = Pick<ClientSettings, "windowMaterial" | "windowBlur">;

export function getWindowMaterialOptions(
  platform: NodeJS.Platform,
  shouldUseDarkColors: boolean,
  settings: WindowMaterialSettings,
): BrowserWindowConstructorOptions {
  if (platform === "darwin" && settings.windowMaterial === "translucent") {
    return {
      backgroundColor: "#00000000",
      vibrancy: MAC_WINDOW_VIBRANCY,
      visualEffectState: "followWindow",
    };
  }
  return { backgroundColor: shouldUseDarkColors ? "#181818" : "#ffffff" };
}

export function createWindowMaterialApplier(loadAddon: () => WindowMaterialAddon | null) {
  let addon: WindowMaterialAddon | null | undefined;
  const applied = new WeakMap<MaterialWindow, { readonly key: string; readonly result: boolean }>();

  return (
    window: MaterialWindow,
    settings: WindowMaterialSettings,
    shouldUseDarkColors: boolean,
  ): boolean => {
    const key = `${settings.windowMaterial}:${settings.windowBlur}:${shouldUseDarkColors}`;
    const previous = applied.get(window);
    if (previous?.key === key) return previous.result;

    if (settings.windowMaterial === "solid") {
      addon?.setBackgroundBlurRadius(window.getNativeWindowHandle(), 0);
      window.setVibrancy(null);
      window.setBackgroundColor(shouldUseDarkColors ? "#181818" : "#ffffff");
      applied.set(window, { key, result: true });
      return true;
    }

    window.setBackgroundColor("#00000000");
    if (addon === undefined) addon = loadAddon();
    if (addon) {
      window.setVibrancy(null);
      if (addon.setBackgroundBlurRadius(window.getNativeWindowHandle(), settings.windowBlur)) {
        applied.set(window, { key, result: true });
        return true;
      }
    }
    // macOS can remove the private WindowServer API; native vibrancy remains a
    // supported frosted backing when the adjustable blur cannot be applied.
    window.setVibrancy(MAC_WINDOW_VIBRANCY);
    applied.set(window, { key, result: false });
    return false;
  };
}
