import { useEffect } from "react";

import { isElectron } from "../../env";
import { useClientSettings } from "../../hooks/useSettings";
import { syncBrowserChromeTheme } from "../../hooks/useTheme";
import { isMacPlatform } from "../../lib/utils";

import "../../windowMaterial.css";

export function WindowMaterialSync() {
  const material = useClientSettings((settings) => settings.windowMaterial);
  const sidebarOnly = useClientSettings((settings) => settings.windowSidebarOnly);
  const opacity = useClientSettings((settings) => settings.windowOpacity);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Mirrors window material settings onto the document root.
  useEffect(() => {
    const root = document.documentElement;
    const translucent =
      isElectron && isMacPlatform(navigator.platform) && material === "translucent";
    root.dataset.windowMaterial = translucent ? "translucent" : "solid";
    root.dataset.windowTranslucency = translucent ? (sidebarOnly ? "sidebar" : "window") : "none";
    root.style.setProperty("--window-opacity", `${opacity}%`);
    syncBrowserChromeTheme();
  }, [material, opacity, sidebarOnly]);

  return null;
}
