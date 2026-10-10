/**
 * The Mail frame's entry (mail-frame.html). Otter Mail's renderer assumes it
 * owns its document (its `<html>` classes and tokens, window shortcuts,
 * portals, Tailwind's preflight), so it runs here, in a same-origin frame of
 * the /mail page, with the `desktopBridge` it expects: built on the parent's
 * `__otterMailHost` (../mailHost.ts), which reaches Mail's core on the server.
 *
 * The bridge reports the real OS (Mail then uses hash history, which the
 * parent mirrors into `/mail?at=`), switches off every desktop feature, and
 * answers the desktop shell's own channels (`frameChannels.ts`). Mail's agent
 * panel and its Agents, Account and Browser settings are hidden: Otterware's
 * side chat and Otter Code's settings own those.
 */
import { decodeMailBytes, encodeMailBytes, type SuiteMailEvent } from "@t3tools/contracts/suite";

import type { OtterMailHost } from "../mailHost";
import { receiveMailGoogleAuth } from "../mailGoogleAuth";
import { receiveMailMicrosoftAuth } from "../mailMicrosoftAuth";
import { showGoogleAuthPrompt } from "./googleAuthPrompt";
import { FRAME_CHANNELS, inertAnswer, isFrameChannel } from "./frameChannels";
import { mailConversationFromPath, mailPathSegments } from "./mailRoute";
import { startThemeBridge } from "./themeBridge";

/** Mail's build-time constants (its vite.config.ts `define`), as globals for its modules. */
Object.assign(globalThis, {
  __APP_VERSION__: "otterware",
  __APP_DISPLAY_NAME__: "Mail",
  __DEMO__: false,
  __DEV_DEMO__: false,
});

/** Mail's settings panes Otterware leaves out, and what they fall back to. */
const HIDDEN_SETTINGS_PANES = ["agents", "otter", "browser"] as const;

type Listener = (params: unknown) => void;

function parentHost(): OtterMailHost | null {
  try {
    return window.parent !== window ? (window.parent.__otterMailHost ?? null) : null;
  } catch {
    return null;
  }
}

function osPlatform(): string {
  const platform = `${navigator.platform} ${navigator.userAgent}`;
  if (/Mac|iPhone|iPad/i.test(platform)) return "darwin";
  if (/Win/i.test(platform)) return "win32";
  return "linux";
}

function showNotice(message: string, link?: { readonly label: string; readonly url: string }) {
  const notice = document.createElement("div");
  notice.setAttribute("role", "status");
  notice.style.cssText =
    "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:12px;align-items:center;max-width:min(560px,calc(100% - 32px));padding:10px 14px;border-radius:10px;font:13px/1.4 var(--font-sans,system-ui);background:var(--popover);color:var(--popover-foreground);border:1px solid var(--border);box-shadow:0 8px 24px rgb(0 0 0/.18)";
  const text = document.createElement("span");
  text.textContent = message;
  notice.append(text);
  if (link) {
    const anchor = document.createElement("a");
    anchor.href = link.url;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.textContent = link.label;
    anchor.style.cssText = "color:var(--primary);font-weight:500;white-space:nowrap";
    anchor.addEventListener("click", () => notice.remove());
    notice.append(anchor);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");
  close.style.cssText = "border:0;background:none;color:inherit;font-size:16px;cursor:pointer";
  close.addEventListener("click", () => notice.remove());
  notice.append(close);
  document.body.append(notice);
}

function boot(host: OtterMailHost): void {
  // Mail shares its available width with the suite assistant. Its existing
  // full-inbox layout gives the reader that width and a back button instead
  // of squeezing three Mail columns beside chat. Keep any explicit choice.
  if (localStorage.getItem("otter:mail-layout") === null) {
    localStorage.setItem("otter:mail-layout", "full");
  }
  const listeners = new Map<string, Set<Listener>>();
  const emit = (channel: string, params?: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener(params);
  };
  let serverChannels = new Set<string>();

  // ── Things that need the user's click ────────────────────────────────────

  let startedPick: Promise<unknown[]> | null = null;
  function pickFiles(): Promise<unknown[]> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.addEventListener("cancel", () => resolve([]));
      input.addEventListener("change", async () => {
        const files = [...(input.files ?? [])];
        resolve(
          await Promise.all(
            files.map(async (file) => ({
              name: file.name,
              mimeType: file.type || "application/octet-stream",
              bytes: new Uint8Array(await file.arrayBuffer()),
            })),
          ),
        );
      });
      input.click();
    });
  }

  function saveBytes(name: string, bytes: Uint8Array, open: boolean): void {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    if (open) window.open(url, "_blank", "noopener");
    else Object.assign(document.createElement("a"), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /** Opens `url` in the browser (the desktop app's shell, or a new tab); offers a link when blocked. */
  async function openUrl(url: string): Promise<void> {
    if (window.parent.desktopBridge) {
      await host.openExternal(url);
      return;
    }
    const opened = window.open("about:blank", "_blank");
    if (opened) {
      opened.opener = null;
      opened.location.href = url;
    } else showNotice("Your browser blocked a new tab.", { label: "Open it", url });
  }

  // ── Core's asks of this client ───────────────────────────────────────────

  const oauthRequests = new Map<number, AbortController>();

  async function answer(event: Extract<SuiteMailEvent, { type: "request" }>): Promise<unknown> {
    const params = decodeMailBytes(event.params) as Record<string, unknown> | undefined;
    switch (event.kind) {
      case "googleAuth": {
        const controller = new AbortController();
        oauthRequests.set(event.id, controller);
        try {
          return await receiveMailGoogleAuth({
            authorizationUrl: String(params?.authorizationUrl ?? ""),
            signal: controller.signal,
            openBrowser: openUrl,
            receiveNative: host.receiveGoogleAuthCallback,
            cancelNative: host.cancelGoogleAuthCallback,
            prompt: showGoogleAuthPrompt,
          });
        } finally {
          oauthRequests.delete(event.id);
        }
      }
      case "microsoftAuth": {
        const controller = new AbortController();
        oauthRequests.set(event.id, controller);
        try {
          return await receiveMailMicrosoftAuth({
            authorizationUrl: String(params?.authorizationUrl ?? ""),
            signal: controller.signal,
            openBrowser: openUrl,
            prompt: showGoogleAuthPrompt,
          });
        } finally {
          oauthRequests.delete(event.id);
        }
      }
      case "openExternal":
        await openUrl(String(params?.url ?? ""));
        return undefined;
      case "pickFiles": {
        const files = await (startedPick ?? pickFiles());
        startedPick = null;
        return files;
      }
      case "openFile":
      case "saveFile":
        saveBytes(
          String(params?.name ?? "file"),
          params?.bytes as Uint8Array,
          event.kind === "openFile",
        );
        return event.kind === "saveFile" ? true : undefined;
    }
  }

  let pendingOpenMessage: { accountId: string; messageId: string } | null = null;

  host.listen((event) => {
    switch (event.type) {
      case "ready":
        serverChannels = new Set(event.channels);
        return;
      case "failed":
        for (const controller of oauthRequests.values()) controller.abort();
        showNotice(`Mail couldn't start on this server: ${event.message}`);
        return;
      case "requestCancelled":
        oauthRequests.get(event.id)?.abort();
        return;
      case "event":
        emit(event.channel, decodeMailBytes(event.params));
        return;
      case "request":
        answer(event).then(
          (result) => host.reply(event.id, encodeMailBytes(result)),
          (error: unknown) =>
            host.reply(event.id, undefined, error instanceof Error ? error.message : String(error)),
        );
        return;
      case "notify":
        if ("Notification" in window && Notification.permission === "granted") {
          const notification = new Notification(event.title, {
            body: [event.subtitle, event.body].filter(Boolean).join(" · "),
          });
          notification.addEventListener("click", () => {
            window.parent.focus();
            notification.close();
            if (!event.open) return;
            pendingOpenMessage = { ...event.open };
            emit("mail:open");
          });
        }
        return;
      case "unread":
        return;
    }
  });

  // ── The desktop shell's own channels ─────────────────────────────────────

  let settingsTarget: unknown = null;
  const frameChannels: Record<(typeof FRAME_CHANNELS)[number], (params: unknown) => unknown> = {
    "window:openSettings": (params) => {
      const pane = (params as { pane?: unknown } | undefined)?.pane;
      settingsTarget = (HIDDEN_SETTINGS_PANES as ReadonlyArray<unknown>).includes(pane)
        ? { pane: "general" }
        : params;
      emit("settings:open");
    },
    "window:getSettingsTarget": () => {
      const target = settingsTarget;
      settingsTarget = null;
      return target;
    },
    "window:takePendingOpenMessage": () => {
      const target = pendingOpenMessage;
      pendingOpenMessage = null;
      return target;
    },
    "window:closeMain": () => undefined,
    "appIcon:get": () => "codex",
    "appIcon:set": (id) => id,
    "app:takePendingMailto": () => null,
    "edit:nativeUndo": () => document.execCommand("undo"),
    "edit:nativeRedo": () => document.execCommand("redo"),
  };

  async function invoke<T>(channel: string, params?: unknown): Promise<T> {
    const local = frameChannels[channel as keyof typeof frameChannels];
    if (local) return (await local(params)) as T;
    if (isFrameChannel(channel) && !serverChannels.has(channel)) return inertAnswer(channel) as T;
    // Start what needs the click now, while it still counts as the user's.
    if (channel === "gmail:pickAttachments") startedPick = pickFiles();
    return decodeMailBytes(await host.invoke(channel, encodeMailBytes(params))) as T;
  }

  const dark = () => document.documentElement.classList.contains("dark");
  const themeInfo = () => ({
    shouldUseDarkColors: dark(),
    themeSource: (dark() ? "dark" : "light") as "dark" | "light",
    shouldUseHighContrastColors: window.matchMedia("(prefers-contrast: more)").matches,
    prefersReducedTransparency: window.matchMedia("(prefers-reduced-transparency: reduce)").matches,
  });
  const updatesDisabled = {
    status: "disabled" as const,
    currentVersion: "otterware",
    availableVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: "Otterware updates Mail with the app.",
    manualDownloadUrl: null,
  };

  window.desktopBridge = {
    platform: osPlatform(),
    features: {
      windowControls: null,
      vibrancy: false,
      historyButtons: false,
      launchAtLogin: false,
      dockBadge: false,
      defaultMailApp: false,
      translation: false,
      dragOut: false,
      openFiles: false,
      externalAgent: false,
      localAgents: false,
      browser: false,
    },
    invoke,
    on(channel: string, listener: Listener) {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(listener);
      return () => void set.delete(listener);
    },
    openExternal: openUrl,
    nativeTheme: {
      getInfo: async () => themeInfo(),
      // Otter Code's appearance settings own light and dark here.
      setThemeSource: async () => {},
    },
    updates: {
      getState: async () => updatesDisabled,
      check: async () => updatesDisabled,
      download: async () => updatesDisabled,
      install: async () => {},
      onState: () => () => {},
    },
  } as unknown as NonNullable<Window["desktopBridge"]>;

  startThemeBridge(window.parent.document, () =>
    window.dispatchEvent(new Event("otter:theme-change")),
  );

  // ⌘Z / ⇧⌘Z undo Mail's actions outside text fields (the Mac app's Edit menu sends these).
  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "z" || !(event.metaKey || event.ctrlKey)) return;
    if (event.altKey || event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable]"))
      return;
    event.preventDefault();
    emit(event.shiftKey ? "edit:redo" : "edit:undo");
  });

  // Notifications need permission, which browsers only ask for after a click.
  if ("Notification" in window && Notification.permission === "default") {
    window.addEventListener("pointerdown", () => void Notification.requestPermission(), {
      once: true,
    });
  }

  // ── Where Mail is, for the parent's URL and the side chat ────────────────

  let reported = "";
  const report = () => {
    const path = location.hash.replace(/^#/, "") || "/";
    const segments = mailPathSegments(path);
    const hidden =
      segments?.[0] === "settings" && HIDDEN_SETTINGS_PANES.some((pane) => pane === segments[1]);
    if (hidden) {
      location.replace(`#/settings/general`);
      return;
    }
    if (path === reported) return;
    reported = path;
    host.navigated(path);
    const conversation = mailConversationFromPath(path);
    if (!conversation) {
      host.showing(null);
      return;
    }
    host
      .invoke("gmail:getMessage", conversation)
      .then((detail) => {
        if (reported !== path) return;
        const subject = (detail as { subject?: unknown } | null)?.subject;
        host.showing({
          title: typeof subject === "string" && subject ? subject : "(no subject)",
          path,
        });
      })
      .catch(() => {
        if (reported === path) host.showing({ title: "Conversation", path });
      });
  };
  // TanStack hash history writes pushState/replaceState, which do not emit hashchange.
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method].bind(history);
    history[method] = (data: unknown, unused: string, url?: string | URL | null) => {
      original(data, unused, url);
      report();
    };
  }
  window.addEventListener("hashchange", report);
  window.addEventListener("popstate", report);
  report();
}

/** Hides what Otterware doesn't use, by the hooks Mail's markup has (see the file comment). */
function injectFrameStyles(): void {
  const style = document.createElement("style");
  style.id = "otterware-mail-frame";
  style.textContent = `
[aria-label="Toggle agent panel"],
[data-tour="agent"],
:has(+ [data-tour="agent"]):not(:has([data-tour])) { display: none !important; }
[data-otterware-hidden] { display: none !important; }
`;
  document.head.append(style);
}

/** Hides the settings rows (and search results) of the panes Otterware leaves out. */
async function hideSettingsRows(): Promise<void> {
  const { SETTINGS_SECTION_LABELS } = await import("otter-mail:settings-search");
  const hidden = new Set(HIDDEN_SETTINGS_PANES.map((pane) => SETTINGS_SECTION_LABELS[pane]));
  const sweep = () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "button[aria-current], button[type=button]:not([data-otterware-hidden])",
    )) {
      const labels = [...button.querySelectorAll(":scope > span")].map((span) =>
        span.textContent?.trim(),
      );
      const label =
        labels.length === 1
          ? labels[0]
          : button.querySelector(":scope > span > span:last-child")?.textContent?.trim();
      if (label && hidden.has(label) && button.querySelector(":scope > svg")) {
        button.setAttribute("data-otterware-hidden", "");
      }
    }
  };
  new MutationObserver(sweep).observe(document.body, { childList: true, subtree: true });
  sweep();
}

const host = parentHost();
if (host === null) {
  document.body.textContent = "Open Mail from Otterware.";
} else {
  // Mail's own agent panel starts closed; Otterware's side chat is beside the frame.
  localStorage.setItem("gmail:chat-open", "0");
  injectFrameStyles();
  boot(host);
  await import("otter-mail:renderer");
  void hideSettingsRows();
}
