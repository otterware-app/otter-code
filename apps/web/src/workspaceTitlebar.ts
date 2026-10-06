// "hidden" (pages without the sidebar) clears only the traffic lights, there being no toggle.
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)] [[data-sidebar-state=hidden]_&]:pl-[max(var(--workspace-gutter-start),calc(var(--workspace-controls-left)-var(--workspace-rail-width)))]";
