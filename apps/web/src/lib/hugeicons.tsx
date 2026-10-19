// Hugeicons (stroke, rounded) inlined as SVG so the package is not a dependency; re-exported
// from ~/lib/icons. Paths are verbatim from @hugeicons/core-free-icons 4.3.5 (MIT).
// To add one, print its entry with `node apps/web/scripts/hugeicon-snippet.mjs <icon-name>`.

import type { SVGProps } from "react";

type LucideIcon = (props: SVGProps<SVGSVGElement>) => import("react").ReactNode;

interface HugeiconPath {
  d: string;
  // Hugeicons leaves the cap off lines that meet the frame, so they stop flush with it.
  round?: boolean;
  // Some paths round only the cap or only the join (the folders); `round` sets both.
  roundCap?: boolean;
  roundJoin?: boolean;
}

// Hugeicons draws a 1.5 stroke on a 24 grid, under 1px once shrunk to the 12–14px of
// meta rows and menus; callers rendering one that small pass a heavier `strokeWidth`.
// `mirror` flips the drawing left to right, then `rotate` turns it clockwise by that many degrees;
// both pivot on the center of the grid.
function createHugeicon(
  displayName: string,
  paths: readonly HugeiconPath[],
  options: { strokeWidth?: number; rotate?: number; mirror?: boolean } = {},
): LucideIcon {
  const drawnPaths = paths.map((path) => (
    <path
      key={path.d}
      d={path.d}
      {...(path.round || path.roundCap ? { strokeLinecap: "round" } : {})}
      {...(path.round || path.roundJoin ? { strokeLinejoin: "round" } : {})}
    />
  ));
  const transform =
    [
      options.rotate ? `rotate(${options.rotate} 12 12)` : null,
      options.mirror ? "translate(24 0) scale(-1 1)" : null,
    ]
      .filter(Boolean)
      .join(" ") || null;
  function Hugeicon(props: SVGProps<SVGSVGElement>) {
    const labelled = Boolean(props["aria-label"] || props["aria-labelledby"]);
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={24}
        height={24}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={options.strokeWidth ?? 1.5}
        role={labelled ? "img" : undefined}
        aria-hidden={labelled ? undefined : true}
        data-slot="hugeicon"
        {...props}
      >
        {transform ? <g transform={transform}>{drawnPaths}</g> : drawnPaths}
      </svg>
    );
  }
  Hugeicon.displayName = displayName;
  return Hugeicon;
}

/** The one closed folder: projects, paths, and file-tree rows (`folder-closed`). */
export const FolderClosedIcon = createHugeicon("FolderClosedIcon", [
  {
    d: "M2 13C2.06427 12.3499 2.20951 11.9124 2.53777 11.5858C3.12654 11 4.07416 11 5.9694 11H18.0306C19.9258 11 20.8735 11 21.4622 11.5858C21.7905 11.9124 21.9357 12.3499 22 13",
    round: true,
  },
  {
    d: "M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C22 9.08996 22 10.1433 22 12.25C22 15.7612 22 17.5167 21.1573 18.7779C20.7926 19.3238 20.3238 19.7926 19.7779 20.1573C18.5167 21 16.7612 21 13.25 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7",
    roundCap: true,
  },
]);

/** The one open folder: an expanded project or directory, and "open in folder" actions (`folder-02`). */
export const Folder02Icon = createHugeicon("Folder02Icon", [
  {
    d: "M2 19V7.54902C2 6.10516 2 5.38322 2.24332 4.81647C2.5467 4.10985 3.10985 3.5467 3.81647 3.24332C4.38322 3 5.09805 3 6.54902 3H7.04311C7.64819 3 8.22075 3.27394 8.60041 3.74509L10.4175 6M10.4175 6H16C17.4001 6 18.1002 6 18.635 6.27248C19.1054 6.51217 19.4878 6.89462 19.7275 7.36502C20 7.8998 20 8.59987 20 10V11M10.4175 6H7",
    round: true,
  },
  {
    d: "M3.15802 15.5144L3.45643 14.7717C4.19029 12.9449 4.55723 12.0316 5.3224 11.5158C6.08757 11 7.07557 11 9.05157 11H17.1119C19.8004 11 21.1446 11 21.7422 11.8787C22.3397 12.7575 21.8405 14.0002 20.842 16.4856L20.5436 17.2283C19.8097 19.0551 19.4428 19.9684 18.6776 20.4842C17.9124 21 16.9244 21 14.9484 21H6.88812C4.19961 21 2.85535 21 2.25782 20.1213C1.66029 19.2425 2.15953 17.9998 3.15802 15.5144Z",
    roundJoin: true,
  },
]);

/** Stacked folders: the explorer / file tree and the Spaces rail item (`folder-library`). */
export const FolderLibraryIcon = createHugeicon("FolderLibraryIcon", [
  {
    d: "M16.2627 10.5H7.73725C5.15571 10.5 3.86494 10.5 3.27143 11.3526C2.67793 12.2052 3.11904 13.4258 4.00126 15.867L5.08545 18.867C5.54545 20.1398 5.77545 20.7763 6.2889 21.1381C6.80235 21.5 7.47538 21.5 8.82143 21.5H15.1786C16.5246 21.5 17.1976 21.5 17.7111 21.1381C18.2245 20.7763 18.4545 20.1398 18.9146 18.867L19.9987 15.867C20.881 13.4258 21.3221 12.2052 20.7286 11.3526C20.1351 10.5 18.8443 10.5 16.2627 10.5Z",
  },
  {
    d: "M19 8C19 7.53406 19 7.30109 18.9239 7.11732C18.8224 6.87229 18.6277 6.67761 18.3827 6.57612C18.1989 6.5 17.9659 6.5 17.5 6.5H6.5C6.03406 6.5 5.80109 6.5 5.61732 6.57612C5.37229 6.67761 5.17761 6.87229 5.07612 7.11732C5 7.30109 5 7.53406 5 8",
    round: true,
  },
  {
    d: "M16.5 4C16.5 3.53406 16.5 3.30109 16.4239 3.11732C16.3224 2.87229 16.1277 2.67761 15.8827 2.57612C15.6989 2.5 15.4659 2.5 15 2.5H9C8.53406 2.5 8.30109 2.5 8.11732 2.57612C7.87229 2.67761 7.67761 2.87229 7.57612 3.11732C7.5 3.30109 7.5 3.53406 7.5 4",
    round: true,
  },
]);

/** Add a folder or project: ⌘K "Add project" and the folder pickers (`folder-add`). */
export const FolderAddIcon = createHugeicon("FolderAddIcon", [
  {
    d: "M13 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C21.9796 9.05942 21.9992 10.0588 22 12",
    roundCap: true,
  },
  { d: "M18 13V21M22 17H14", round: true },
]);

/** Inbox: the sidebar nav entry and the rail's Inbox item (`inbox`). */
export const InboxIcon = createHugeicon("InboxIcon", [
  {
    d: "M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z",
    round: true,
  },
  {
    d: "M21.5 13.5H16.5743C15.7322 13.5 15.0706 14.2036 14.6995 14.9472C14.2963 15.7551 13.4889 16.5 12 16.5C10.5111 16.5 9.70373 15.7551 9.30054 14.9472C8.92942 14.2036 8.26777 13.5 7.42566 13.5H2.5",
    roundJoin: true,
  },
]);

/** Home: the rail's Home item (`home-07`). */
export const Home07Icon = createHugeicon("Home07Icon", [
  {
    d: "M12.8924 2.80982L21.4876 9.59547C21.8112 9.85095 22 10.2405 22 10.6528C22 11.3969 21.3969 12 20.6528 12H20V15.5C20 18.3284 20 19.7426 19.1213 20.6213C18.2426 21.5 16.8284 21.5 14 21.5H10C7.17157 21.5 5.75736 21.5 4.87868 20.6213C4 19.7426 4 18.3284 4 15.5V12H3.34716C2.60315 12 2 11.3969 2 10.6528C2 10.2405 2.1888 9.85095 2.5124 9.59547L11.1076 2.80982C11.3617 2.60915 11.6761 2.5 12 2.5C12.3239 2.5 12.6383 2.60915 12.8924 2.80982Z",
    round: true,
  },
  {
    d: "M14.5 21.5V17C14.5 16.0654 14.5 15.5981 14.299 15.25C14.1674 15.022 13.978 14.8326 13.75 14.701C13.4019 14.5 12.9346 14.5 12 14.5C11.0654 14.5 10.5981 14.5 10.25 14.701C10.022 14.8326 9.83261 15.022 9.70096 15.25C9.5 15.5981 9.5 16.0654 9.5 17V21.5",
    round: true,
  },
]);

/** Code review: the sidebar entry, the project row's shortcut, and the rail item (`git-compare-arrows`). */
export const GitCompareArrowsIcon = createHugeicon("GitCompareArrowsIcon", [
  {
    d: "M5 9.00098C6.65685 9.00098 8 7.65783 8 6.00098C8 4.34412 6.65685 3.00098 5 3.00098C3.34315 3.00098 2 4.34412 2 6.00098C2 7.65783 3.34315 9.00098 5 9.00098Z",
    round: true,
  },
  {
    d: "M12 6.00146H14C15.8692 6.00146 16.8038 6.00146 17.5 6.40339C17.9561 6.66669 18.3348 7.04541 18.5981 7.50146C19 8.19762 19 9.13223 19 11.0015",
    round: true,
  },
  {
    d: "M19 21.001C20.6569 21.001 22 19.6578 22 18.001C22 16.3441 20.6569 15.001 19 15.001C17.3431 15.001 16 16.3441 16 18.001C16 19.6578 17.3431 21.001 19 21.001Z",
    round: true,
  },
  {
    d: "M12 18.002H10C8.13077 18.002 7.19615 18.002 6.5 17.6C6.04394 17.3367 5.66523 16.958 5.40192 16.502C5 15.8058 5 14.8712 5 13.002",
    round: true,
  },
  {
    d: "M9.00002 15.001C9.00002 15.001 12 17.2104 12 18.001C12 18.7916 9 21.001 9 21.001",
    round: true,
  },
  {
    d: "M15 9.00195C15 9.00195 12 6.79249 12 6.00193C12 5.21137 15 3.00195 15 3.00195",
    round: true,
  },
]);

/** Schedule: Automations everywhere they appear, plus snooze and scheduled sends (`clock-hour-7`). */
export const ClockHour7Icon = createHugeicon("ClockHour7Icon", [
  { d: "M2 12A10 10 0 1 0 22 12A10 10 0 1 0 2 12Z", round: true },
  { d: "M12 6V12L10 15.5", round: true },
]);

/** Terminal: panes, tabs, thread rows, command output, and the "Open in terminal" action (`square-terminal`). */
export const SquareTerminalIcon = createHugeicon("SquareTerminalIcon", [
  {
    d: "M7.49219 7.5L8.71873 8.55719C9.23437 9.00163 9.49219 9.22386 9.49219 9.5C9.49219 9.77614 9.23437 9.99836 8.71873 10.4428L7.49219 11.5",
    round: true,
  },
  { d: "M11.4922 12.5H15.4922", round: true },
  {
    d: "M11.9922 21C15.7419 21 17.6168 21 18.9311 20.0451C19.3556 19.7367 19.7289 19.3634 20.0373 18.9389C20.9922 17.6246 20.9922 15.7497 20.9922 12C20.9922 8.25027 20.9922 6.3754 20.0373 5.06107C19.7289 4.6366 19.3556 4.26331 18.9311 3.95491C17.6168 3 15.7419 3 11.9922 3C8.24246 3 6.36759 3 5.05326 3.95491C4.62879 4.26331 4.2555 4.6366 3.9471 5.06107C2.99219 6.3754 2.99219 8.25027 2.99219 12C2.99219 15.7497 2.99219 17.6246 3.9471 18.9389C4.2555 19.3634 4.62879 19.7367 5.05326 20.0451C6.36759 21 8.24246 21 11.9922 21Z",
    round: true,
  },
]);

/** Open outside the app: external links, Finder reveal, GitHub, and "Open PR in browser" (`link-square-02`). */
export const LinkSquare02Icon = createHugeicon("LinkSquare02Icon", [
  {
    d: "M11.0991 3.00012C7.45013 3.00669 5.53932 3.09629 4.31817 4.31764C3.00034 5.63568 3.00034 7.75704 3.00034 11.9997C3.00034 16.2424 3.00034 18.3638 4.31817 19.6818C5.63599 20.9999 7.75701 20.9999 11.9991 20.9999C16.241 20.9999 18.3621 20.9999 19.6799 19.6818C20.901 18.4605 20.9906 16.5493 20.9972 12.8998",
    round: true,
  },
  {
    d: "M20.556 3.49612L11.0487 13.0586M20.556 3.49612C20.062 3.00151 16.7343 3.04761 16.0308 3.05762M20.556 3.49612C21.05 3.99074 21.0039 7.32273 20.9939 8.02714",
    round: true,
  },
]);

/** Branch: the branch pickers, thread rows, and every branch/fork marker (`workflow-circle-05`). */
export const WorkflowCircle05Icon = createHugeicon("WorkflowCircle05Icon", [
  {
    d: "M9 5C9 6.65685 7.65685 8 6 8C4.34315 8 3 6.65685 3 5C3 3.34315 4.34315 2 6 2C7.65685 2 9 3.34315 9 5Z",
  },
  {
    d: "M21 5C21 6.65685 19.6569 8 18 8C16.3431 8 15 6.65685 15 5C15 3.34315 16.3431 2 18 2C19.6569 2 21 3.34315 21 5Z",
  },
  {
    d: "M9 19C9 20.6569 7.65685 22 6 22C4.34315 22 3 20.6569 3 19C3 17.3431 4.34315 16 6 16C7.65685 16 9 17.3431 9 19Z",
  },
  { d: "M6 8V16", round: true },
  {
    d: "M6 12H14C15.4001 12 16.1002 12 16.635 11.7275C17.1054 11.4878 17.4878 11.1054 17.7275 10.635C18 10.1002 18 9.40013 18 8",
    round: true,
  },
]);

/** Draft pull request, from the same family as the open glyph (`git-pull-request-draft`). */
export const GitPullRequestDraftIcon = createHugeicon("GitPullRequestDraftIcon", [
  { d: "M6 8L6 16", round: true },
  { d: "M4 18A2 2 0 1 0 8 18A2 2 0 1 0 4 18Z" },
  { d: "M4 6A2 2 0 1 0 8 6A2 2 0 1 0 4 6Z" },
  { d: "M16 18A2 2 0 1 0 20 18A2 2 0 1 0 16 18Z" },
  {
    d: "M18.125 11H18M18.25 11C18.25 11.1381 18.1381 11.25 18 11.25C17.8619 11.25 17.75 11.1381 17.75 11C17.75 10.8619 17.8619 10.75 18 10.75C18.1381 10.75 18.25 10.8619 18.25 11Z",
    roundCap: true,
  },
  {
    d: "M18.125 6H18M18.25 6C18.25 6.13807 18.1381 6.25 18 6.25C17.8619 6.25 17.75 6.13807 17.75 6C17.75 5.86193 17.8619 5.75 18 5.75C18.1381 5.75 18.25 5.86193 18.25 6Z",
    roundCap: true,
  },
]);

/** Closed pull request, from the same family as the open glyph (`git-pull-request-closed`). */
export const GitPullRequestClosedIcon = createHugeicon("GitPullRequestClosedIcon", [
  { d: "M6 8L6 16", round: true },
  { d: "M18 11L18 16", round: true },
  { d: "M4 18A2 2 0 1 0 8 18A2 2 0 1 0 4 18Z" },
  { d: "M4 6A2 2 0 1 0 8 6A2 2 0 1 0 4 6Z" },
  { d: "M16 18A2 2 0 1 0 20 18A2 2 0 1 0 16 18Z" },
  { d: "M20 4L18 6M18 6L16 8M18 6L20 8M18 6L16 4", round: true },
]);

/** Three dots: the browser actions menu (`more-horizontal`). */
export const MoreHorizontalIcon = createHugeicon("MoreHorizontalIcon", [
  {
    d: "M6.00449 12.5V12M18.0045 12.5V12M12.0045 12.5V12M7.00449 12.5C7.00449 11.9477 6.55677 11.5 6.00449 11.5C5.4522 11.5 5.00449 11.9477 5.00449 12.5C5.00449 13.0523 5.4522 13.5 6.00449 13.5C6.55677 13.5 7.00449 13.0523 7.00449 12.5ZM19.0045 12.5C19.0045 11.9477 18.5568 11.5 18.0045 11.5C17.4522 11.5 17.0045 11.9477 17.0045 12.5C17.0045 13.0523 17.4522 13.5 18.0045 13.5C18.5568 13.5 19.0045 13.0523 19.0045 12.5ZM13.0045 12.5C13.0045 11.9477 12.5568 11.5 12.0045 11.5C11.4522 11.5 11.0045 11.9477 11.0045 12.5C11.0045 13.0523 11.4522 13.5 12.0045 13.5C12.5568 13.5 13.0045 13.0523 13.0045 12.5Z",
    round: true,
  },
]);
