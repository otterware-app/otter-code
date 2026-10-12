/**
 * Mail renderer channels the Otterware frame answers itself instead of the
 * server: the window and app shell Mail's desktop main process owns, and the
 * desktop-only features the frame switches off (`features` all false), which
 * get inert answers. Everything else goes to Mail's core on the server.
 *
 * `scripts/otterware/sync-otter-mail.ts` imports this file (plain Node, no
 * imports here) to fail a sync when the renderer starts invoking a channel
 * that neither core nor the frame answers.
 */

/** Answered by the frame entry (`entry.ts`) itself. */
export const FRAME_CHANNELS = [
  "window:openSettings",
  "window:getSettingsTarget",
  "window:takePendingOpenMessage",
  "window:closeMain",
  "appIcon:get",
  "appIcon:set",
  "app:takePendingMailto",
  "edit:nativeUndo",
  "edit:nativeRedo",
] as const;

/**
 * Desktop-only namespaces (Electron main's): unless the server registers the
 * channel, the frame answers with `inertAnswer`. Their features are off in
 * the frame, so Mail only reaches them from a stray effect.
 */
export const FRAME_STUB_PREFIXES = [
  "app:",
  "browser:",
  "mcp:",
  "support:",
  "window:",
  "appIcon:",
  "edit:",
  "gmail:dragAttachment",
] as const;

export function isFrameChannel(channel: string): boolean {
  return (
    (FRAME_CHANNELS as ReadonlyArray<string>).includes(channel) ||
    FRAME_STUB_PREFIXES.some((prefix) => channel.startsWith(prefix))
  );
}

/** What a switched-off desktop channel answers: nothing to show, nothing done. */
export function inertAnswer(channel: string): unknown {
  return INERT_ANSWERS[channel] ?? null;
}

const INERT_ANSWERS: Readonly<Record<string, unknown>> = {
  "mcp:listAgents": { url: "", tokens: [] },
  "app:getDefaultMailStatus": { isDefault: false },
  "app:setDefaultMailApp": { ok: false },
  "app:listMailApps": [],
  "browser:extensions": [],
  "browser:extensionActions": [],
  "support:takeRequested": false,
  "support:agents": [],
  "gmail:dragAttachment": { ok: false },
};
