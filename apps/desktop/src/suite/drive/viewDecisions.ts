/** IPC decisions independent of Electron, shared by the handler and its tests. */
export function driveNavigationUrl(
  action: "show" | "open",
  initialUrl: string,
  currentUrl: string | null,
): string | null {
  if (currentUrl === null || currentUrl === "") return initialUrl;
  return action === "open" && currentUrl !== initialUrl ? initialUrl : null;
}

export function driveAccountChanged(
  previous: string | null | undefined,
  next: string | null,
): boolean {
  return previous !== undefined && previous !== next;
}

export function driveShouldBeVisible(bounds: unknown, failed: string | null): boolean {
  return bounds !== null && failed === null;
}
