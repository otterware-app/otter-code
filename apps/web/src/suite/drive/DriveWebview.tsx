/** The placeholder beneath Electron's native Drive WebContentsView. */
import type { DriveDesktopState } from "@t3tools/contracts/suite";
import { useCallback, useEffect, useState } from "react";
import { useDriveViewStore } from "./driveView";

export function useDriveWebview(baseUrl: string) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [navigation, setNavigation] = useState<DriveDesktopState>({
    url: "",
    title: "",
    canGoBack: false,
    canGoForward: false,
    loading: true,
    failed: null,
  });
  const [ready, setReady] = useState(false);
  const setCurrent = useDriveViewStore((state) => state.setCurrent);
  useEffect(() => {
    const bridge = window.desktopBridge?.drive;
    if (!bridge || !element) return;
    let disposed = false;
    const sync = (state: DriveDesktopState) => {
      if (disposed) return;
      setNavigation(state);
      if (state.url) setCurrent({ url: state.url, title: state.title });
    };
    const unsubscribe = bridge.onState(sync);
    const initial = element.dataset.driveUrl ?? baseUrl;
    void bridge
      .openDriveUrl(initial, baseUrl)
      .then((state) => {
        if (disposed) return;
        sync(state);
        setReady(true);
        last = "";
        schedule();
      })
      .catch((error: unknown) => {
        if (!disposed)
          setNavigation((state) => ({ ...state, loading: false, failed: String(error) }));
      });

    let frame = 0;
    let last = "";
    const update = () => {
      frame = 0;
      // Native child views sit above DOM portals. Withdraw while any dialog,
      // palette or popup is showing, including its exit transition.
      const overlay = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [data-slot="dialog-backdrop"], [data-slot="alert-dialog-backdrop"], [data-slot="command-dialog-backdrop"]',
        ),
      ].some(
        (node) =>
          node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden",
      );
      const rect = element.getBoundingClientRect();
      const bounds =
        !overlay && !document.hidden && rect.width > 0 && rect.height > 0
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null;
      const serialized = JSON.stringify(bounds);
      if (last === serialized) return;
      last = serialized;
      void bridge.setBounds(bounds).catch(() => {
        last = "";
      });
    };
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "aria-modal", "data-open", "data-state"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      disposed = true;
      unsubscribe();
      resize.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      void bridge.setBounds(null).catch(() => undefined);
    };
  }, [baseUrl, element, setCurrent]);

  const requested = useDriveViewStore((state) => state.requested);
  const consume = useDriveViewStore((state) => state.consume);
  useEffect(() => {
    const bridge = window.desktopBridge?.drive;
    if (!bridge || !ready || !requested) return;
    consume(requested.id);
    void bridge.openDriveUrl(requested.url, baseUrl).catch(() => undefined);
  }, [baseUrl, consume, ready, requested]);
  const ref = useCallback((node: HTMLElement | null) => {
    setElement(node);
  }, []);
  return {
    ref,
    navigation,
    goBack: () => {
      void window.desktopBridge?.drive?.command("back");
    },
    goForward: () => {
      void window.desktopBridge?.drive?.command("forward");
    },
    reload: () => {
      void window.desktopBridge?.drive?.command("reload");
    },
  };
}

export function DriveWebview({
  initialUrl,
  webviewRef,
}: {
  readonly initialUrl: string;
  readonly webviewRef: (node: HTMLElement | null) => void;
}) {
  return (
    <div
      ref={webviewRef}
      data-drive-url={initialUrl}
      data-otterware-drive-view
      className="min-h-0 flex-1 bg-background"
    />
  );
}
