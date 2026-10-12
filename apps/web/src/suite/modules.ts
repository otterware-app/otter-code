/**
 * The ONE web registry of Otterware module pages. A module adds its route file
 * (`routes/<module>.tsx`, rendering `SuiteModuleLayout`), its components under
 * `suite/<module>/`, and one entry here; the rail and the command palette
 * follow from it.
 */
import {
  CalendarDaysIcon,
  HardDriveIcon,
  HouseIcon,
  MailIcon,
  type LucideIcon,
} from "lucide-react";

export interface SuiteWebModule {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** A top-level route under `routes/`. */
  readonly path: "/home" | "/mail" | "/calendar" | "/drive";
  /** `start` sits above Code's places in the rail, `end` below them. */
  readonly rail: "start" | "end";
  /** Sort order within its rail section. */
  readonly order: number;
  /**
   * The server module (`suite.capabilities`) the page needs. Without it the
   * page shows a calm empty state, e.g. on a plain Otter Code environment.
   */
  readonly serverModule: string | null;
  readonly searchTerms: ReadonlyArray<string>;
}

export const SUITE_WEB_MODULES: ReadonlyArray<SuiteWebModule> = [
  {
    id: "home",
    label: "Home",
    icon: HouseIcon,
    path: "/home",
    rail: "start",
    order: 0,
    serverModule: "home",
    searchTerms: ["home", "today", "inbox", "needs you"],
  },
  {
    id: "mail",
    label: "Mail",
    icon: MailIcon,
    path: "/mail",
    rail: "end",
    order: 10,
    serverModule: "mail",
    searchTerms: ["mail", "email", "inbox", "messages"],
  },
  {
    id: "calendar",
    label: "Calendar",
    icon: CalendarDaysIcon,
    path: "/calendar",
    rail: "end",
    order: 20,
    serverModule: "calendar",
    searchTerms: ["calendar", "events", "meetings", "schedule"],
  },
  {
    id: "drive",
    label: "Drive",
    icon: HardDriveIcon,
    path: "/drive",
    rail: "end",
    order: 30,
    serverModule: "drive",
    searchTerms: ["drive", "files", "documents", "storage"],
  },
];

export function suiteRailModules(rail: SuiteWebModule["rail"]): ReadonlyArray<SuiteWebModule> {
  return SUITE_WEB_MODULES.filter((module) => module.rail === rail).toSorted(
    (left, right) => left.order - right.order,
  );
}

/** The module page `pathname` is on, including its sub-routes. */
export function suiteModuleForPath(pathname: string): SuiteWebModule | null {
  return (
    SUITE_WEB_MODULES.find(
      (module) => pathname === module.path || pathname.startsWith(`${module.path}/`),
    ) ?? null
  );
}

export function isSuiteModulePath(pathname: string): boolean {
  return suiteModuleForPath(pathname) !== null;
}

/**
 * Otterware opens on Home. Only the app's first landing on `/` redirects:
 * later navigations to `/` (Code's places, Back from Settings) keep Code's
 * draft landing, and deep links to threads are untouched.
 */
function readInitialRoutePath(): string | null {
  if (typeof window === "undefined") return null;
  // Desktop uses hash history (`#/env/thread`); the window path is always "/" there.
  const { hash, pathname } = window.location;
  return hash.startsWith("#/") ? (hash.slice(1).split("?")[0] ?? "/") : pathname;
}

const initialRoutePath = readInitialRoutePath();
let suiteLandingConsumed = false;

/** True once after opening the app or pairing; call from the `/` route's `beforeLoad`. */
export function consumeSuiteLanding(): boolean {
  if (suiteLandingConsumed) return false;
  suiteLandingConsumed = true;
  return initialRoutePath === "/" || initialRoutePath === "" || initialRoutePath === "/pair";
}
