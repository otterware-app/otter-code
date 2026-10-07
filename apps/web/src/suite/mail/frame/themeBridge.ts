/**
 * Otter Code's appearance inside the Mail frame. Mail's design tokens were
 * ported from Otter Code's (apps/web/src/index.css) and mostly share their
 * names; a few are spelled out in Mail (`--canvas` for `--background`,
 * `--sidebar-surface` for `--sidebar`, `--accent-surface` for `--accent`,
 * whose own name means the account color in Mail). This copies the parent's
 * resolved values onto the frame, light or dark with it, and keeps them in
 * sync, so Mail wears whatever theme, contrast and font size Otter Code does.
 * Mail's own theme settings are overridden while it runs here.
 *
 * The frame also adopts the parent's control radius and topbar height.
 */

/** [Mail's variable, Otter Code's variable]. */
const MAPPED_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  ["--canvas", "--background"],
  ["--app-chrome-background", "--app-chrome-background"],
  ["--foreground", "--foreground"],
  ["--card", "--card"],
  ["--card-foreground", "--card-foreground"],
  ["--popover", "--popover"],
  ["--popover-foreground", "--popover-foreground"],
  ["--surface-raised", "--surface-raised"],
  ["--chat-composer-surface", "--surface-raised"],
  ["--primary", "--primary"],
  ["--primary-foreground", "--primary-foreground"],
  ["--secondary", "--secondary"],
  ["--secondary-foreground", "--secondary-foreground"],
  ["--muted", "--muted"],
  ["--muted-foreground", "--muted-foreground"],
  ["--placeholder", "--placeholder"],
  ["--secondary-label", "--secondary-label"],
  ["--icon-muted", "--icon-muted"],
  ["--accent-surface", "--accent"],
  ["--accent-surface-foreground", "--accent-foreground"],
  ["--message-surface", "--message-surface"],
  ["--message-foreground", "--message-foreground"],
  ["--error", "--error"],
  ["--error-foreground", "--error-foreground"],
  ["--error-surface", "--error-surface"],
  ["--destructive", "--destructive"],
  ["--destructive-foreground", "--destructive-foreground"],
  ["--warning", "--warning"],
  ["--warning-foreground", "--warning-foreground"],
  ["--warning-surface", "--warning-surface"],
  ["--success", "--success"],
  ["--success-foreground", "--success-foreground"],
  ["--info", "--info"],
  ["--info-foreground", "--info-foreground"],
  ["--border", "--border"],
  ["--input", "--input"],
  ["--ring", "--ring"],
  ["--sidebar-surface", "--sidebar"],
  ["--sidebar-foreground", "--sidebar-foreground"],
  ["--sidebar-muted-foreground", "--sidebar-muted-foreground"],
  ["--sidebar-control-surface", "--sidebar-control-surface"],
  ["--sidebar-row-hover", "--sidebar-row-hover"],
  ["--sidebar-row-active", "--sidebar-row-active"],
  ["--sidebar-row-selected", "--sidebar-row-selected"],
  ["--sidebar-line", "--sidebar-border"],
  ["--sidebar-icon-color", "--sidebar-icon-color"],
  ["--code-background", "--code-background"],
  ["--code-foreground", "--code-foreground"],
  ["--appearance-contrast-base", "--appearance-contrast-base"],
  ["--appearance-contrast-boost", "--appearance-contrast-boost"],
  ["--appearance-contrast-border-boost", "--appearance-contrast-border-boost"],
  ["--appearance-contrast-target", "--appearance-contrast-target"],
  ["--radius", "--radius"],
  ["--workspace-topbar-height", "--workspace-topbar-height"],
  ["--control-radius", "--control-radius"],
  ["--font-sans", "--font-sans"],
  ["--font-mono", "--font-mono"],
  ["--glass-opacity", "--glass-opacity"],
  ["--glass-blur", "--glass-blur"],
  ["--glass-saturation", "--glass-saturation"],
  ["--app-scrollbar-thumb", "--app-scrollbar-thumb"],
  ["--app-scrollbar-thumb-hover", "--app-scrollbar-thumb-hover"],
];

const STYLE_ID = "otterware-mail-theme";

// Mail keeps its mailbox, view and settings controls in its own rail. Inside
// Otterware they become a toolbar above the inbox, beside the shared app rail.
// This adapter stylesheet leaves upstream Mail and every action intact.
const MAIL_TOOLBAR_CSS = `
:root { --workspace-rail-width: 0px; }
[data-mail-layout] { flex-direction: column; }
nav[aria-label="Spaces"] {
  width: 100%; flex-direction: row; height: 48px; padding: 0 8px;
  gap: 8px; border-bottom: 1px solid var(--border);
}
nav[aria-label="Spaces"] > [aria-hidden],
nav[aria-label="Spaces"] > span { display: none; }
nav[aria-label="Spaces"] > [data-tour="mailbox"] {
  flex: 1; min-width: 0; flex-direction: row; margin-top: 0;
  overflow-x: auto; padding: 4px 0;
}
nav[aria-label="Spaces"] [data-tour="mailbox"] > span[aria-hidden] {
  width: 1px; height: 20px; margin: 0 4px; flex-shrink: 0;
}
`;

export interface ParentAppearance {
  readonly dark: boolean;
  readonly themeId: string;
  readonly css: string;
}

/** The frame's override stylesheet for the parent's current appearance. */
export function readParentAppearance(parent: Document): ParentAppearance {
  const root = parent.documentElement;
  const computed = parent.defaultView?.getComputedStyle(root);
  const declarations: string[] = [];
  for (const [mailVariable, codeVariable] of MAPPED_VARIABLES) {
    const value = computed?.getPropertyValue(codeVariable).trim();
    if (value) declarations.push(`  ${mailVariable}: ${value} !important;`);
  }
  const fontSize = computed?.fontSize;
  // Mail's own tokens are scoped to :root and its sidebar ([data-app-sidebar]); both take the parent's.
  const css = `:root,\n[data-app-sidebar] {\n${declarations.join("\n")}\n}\n${
    fontSize ? `html { font-size: ${fontSize} !important; }\n` : ""
  }${MAIL_TOOLBAR_CSS}`;
  return { dark: root.classList.contains("dark"), themeId: root.dataset.themeId ?? "t3-chat", css };
}

/** Applies the parent's appearance to this document now and whenever the parent's changes. */
export function startThemeBridge(parent: Document, onChange: (dark: boolean) => void): () => void {
  const root = document.documentElement;
  let current: ParentAppearance | null = null;
  let frame = 0;

  const apply = () => {
    frame = 0;
    const next = readParentAppearance(parent);
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
    }
    if (style.textContent !== next.css) style.textContent = next.css;
    // Last in <head>, after Mail's own theme style (apply-theme.ts appends it there too).
    if (document.head.lastElementChild !== style) document.head.appendChild(style);
    root.classList.toggle("dark", next.dark);
    root.style.colorScheme = next.dark ? "dark" : "light";
    root.dataset.themeId = next.themeId;
    if (current?.dark !== next.dark) onChange(next.dark);
    current = next;
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(apply);
  };

  apply();
  const parentObserver = new MutationObserver(schedule);
  parentObserver.observe(parent.documentElement, { attributes: true });
  parentObserver.observe(parent.head, { childList: true, subtree: true, characterData: true });
  // Mail repaints its own theme (the `dark` class, its theme style) on its own events: take it back.
  const frameObserver = new MutationObserver(() => {
    if (current && root.classList.contains("dark") !== current.dark) {
      root.classList.toggle("dark", current.dark);
    }
    if (current && root.dataset.themeId !== current.themeId) root.dataset.themeId = current.themeId;
    if (document.head.lastElementChild?.id !== STYLE_ID) schedule();
  });
  frameObserver.observe(root, { attributes: true, attributeFilter: ["class", "data-theme-id"] });
  frameObserver.observe(document.head, { childList: true });

  return () => {
    cancelAnimationFrame(frame);
    parentObserver.disconnect();
    frameObserver.disconnect();
  };
}
