import { useIsMobile } from "../../hooks/useMediaQuery";

/** The title band sits above a single inset workspace on web and desktop. */
export function useAppFrame(): "window" | "tab" | null {
  const isMobile = useIsMobile();
  if (isMobile) return null;
  return "window";
}
