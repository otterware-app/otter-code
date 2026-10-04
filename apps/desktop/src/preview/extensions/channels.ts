// The renderer's toolbar and Settings (preload.ts's `previewExtensions`).
export const LIST_CHANNEL = "desktop:preview-extensions:list";
export const ACTIONS_CHANNEL = "desktop:preview-extensions:actions";
export const RUN_ACTION_CHANNEL = "desktop:preview-extensions:run-action";
export const SET_ACTIVE_TAB_CHANNEL = "desktop:preview-extensions:set-active-tab";
export const OPEN_OPTIONS_CHANNEL = "desktop:preview-extensions:open-options";
export const OPEN_WEB_STORE_CHANNEL = "desktop:preview-extensions:open-web-store";
export const SET_ENABLED_CHANNEL = "desktop:preview-extensions:set-enabled";
export const REMOVE_CHANNEL = "desktop:preview-extensions:remove";
export const LOAD_UNPACKED_CHANNEL = "desktop:preview-extensions:load-unpacked";
export const CHANGED_CHANNEL = "desktop:preview-extensions:changed";
export const OPEN_TAB_CHANNEL = "desktop:preview-extensions:open-tab";

// Extensions' own workers and pages (preview-extensions-preload.ts).
export const CRX_CALL_CHANNEL = "crx:call";
export const CRX_LISTEN_CHANNEL = "crx:listen";
export const CRX_EVENT_CHANNEL = "crx:event";
