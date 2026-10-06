import { isElectron } from "../../env";
import { useIsMobile } from "../../hooks/useMediaQuery";

/**
 * Otter Mail's window frame (appFrame.css): in the desktop app ("window") the
 * panes' headers sit on a title band above the content panel; in a browser
 * tab ("tab") the panel runs to the page's edges. Phones have none: the
 * sidebar is a sheet there.
 */
export function useAppFrame(): "window" | "tab" | null {
  const isMobile = useIsMobile();
  if (isMobile) return null;
  return isElectron ? "window" : "tab";
}
