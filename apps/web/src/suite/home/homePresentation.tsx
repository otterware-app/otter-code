/**
 * Home's shared pieces: module identity (icon and one restrained hue per app),
 * the card surface, project chips, and the overview query hook.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  SuiteHomeItemModule,
  SuiteHomeOverview,
  SuiteHomeOverviewInput,
  SuiteProject,
} from "@t3tools/contracts/suite";
import {
  CalendarDaysIcon,
  CodeXmlIcon,
  HardDriveIcon,
  MailIcon,
  type LucideIcon,
} from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";

import { ProjectMonogram } from "../../components/ProjectMonogram";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { suiteHomeOverviewQuery } from "./homeRpc";

export const HOME_MODULES: ReadonlyArray<{
  readonly id: SuiteHomeItemModule;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Icon tint, one restrained hue per app. */
  readonly className: string;
}> = [
  {
    id: "code",
    label: "Code",
    icon: CodeXmlIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  { id: "mail", label: "Mail", icon: MailIcon, className: "text-amber-600 dark:text-amber-300" },
  {
    id: "calendar",
    label: "Calendar",
    icon: CalendarDaysIcon,
    className: "text-emerald-600 dark:text-emerald-300",
  },
  { id: "drive", label: "Drive", icon: HardDriveIcon, className: "text-sky-600 dark:text-sky-300" },
];

export function homeModule(id: SuiteHomeItemModule) {
  return HOME_MODULES.find((module) => module.id === id) ?? HOME_MODULES[0]!;
}

/** A module's icon on a tinted tile, for row leading icons. */
export function ModuleTile({
  module,
  size = "md",
}: {
  readonly module: SuiteHomeItemModule;
  readonly size?: "sm" | "md";
}) {
  const presentation = homeModule(module);
  const Icon = presentation.icon;
  return (
    <span
      aria-label={presentation.label}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-muted/70",
        size === "md" ? "size-8 [&_svg]:size-4" : "size-6 [&_svg]:size-3.5",
        presentation.className,
      )}
    >
      <Icon />
    </span>
  );
}

/** Home's card surface: header row, then rows separated by hairlines. */
export const HomeCard = {
  Root: ({ className, ...props }: ComponentProps<"section">) => (
    <section
      {...props}
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card/40 text-foreground shadow-xs/5",
        className,
      )}
    />
  ),
  Header: ({
    icon,
    title,
    detail,
    action,
    className,
  }: {
    readonly icon?: ReactNode;
    readonly title: ReactNode;
    readonly detail?: ReactNode;
    readonly action?: ReactNode;
    readonly className?: string;
  }) => (
    <div
      className={cn(
        "flex min-h-11 items-center gap-2 border-b border-border/50 px-4 py-2 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
        className,
      )}
    >
      {icon}
      <h2 className="shrink-0 font-medium text-sm">{title}</h2>
      {detail ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{detail}</span>
      ) : (
        <span className="flex-1" />
      )}
      {action}
    </div>
  ),
  Rows: ({ className, ...props }: ComponentProps<"div">) => (
    <div {...props} className={cn("[&>*+*]:border-t [&>*+*]:border-border/50", className)} />
  ),
};

export function ProjectChip({ project }: { readonly project: SuiteProject }) {
  return (
    <span className="inline-flex max-w-40 shrink-0 items-center gap-1 rounded-md bg-muted/60 px-1.5 py-px text-muted-foreground text-xs">
      <ProjectMonogram
        text={Array.from(project.name.trim())[0]?.toUpperCase() ?? "?"}
        color={project.color}
        className="size-3"
      />
      <span className="truncate">{project.name}</span>
    </span>
  );
}

export function SuiteProjectMonogram({
  project,
  className,
}: {
  readonly project: Pick<SuiteProject, "name" | "color">;
  readonly className?: string;
}) {
  return (
    <ProjectMonogram
      text={Array.from(project.name.trim())[0]?.toUpperCase() ?? "?"}
      color={project.color}
      className={className}
    />
  );
}

export interface HomeOverviewState {
  readonly environmentId: EnvironmentId | null;
  readonly overview: SuiteHomeOverview | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => void;
}

export function useHomeOverview(input: SuiteHomeOverviewInput = {}): HomeOverviewState {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : suiteHomeOverviewQuery({ environmentId, input }),
  );
  return {
    environmentId,
    overview: query.data,
    error: query.data === null ? query.error : null,
    loading: query.data === null && query.error === null,
    refresh: query.refresh,
  };
}

/** "in 25 min", "in 2 h", "now", or "25 min ago". */
export function formatRelativeMinutes(iso: string, nowMs: number): string {
  const diff = Math.round((Date.parse(iso) - nowMs) / 60_000);
  if (Number.isNaN(diff)) return "";
  if (Math.abs(diff) < 1) return "now";
  const amount =
    Math.abs(diff) < 60 ? `${Math.abs(diff)} min` : `${Math.round(Math.abs(diff) / 60)} h`;
  return diff > 0 ? `in ${amount}` : `${amount} ago`;
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Wall-clock time that updates once a minute, for "in 25 min" labels. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
