/**
 * Home's pages: the day overview, the full needs-you list, agents, one
 * cross-app project, and one saved view. Each publishes page context, so a
 * thread started from here knows where the user was.
 */
import type {
  SuiteHomeOverview,
  SuiteProject,
  SuiteProjectSummary,
} from "@t3tools/contracts/suite";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  CloudOffIcon,
  LayersIcon,
  PencilIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Skeleton } from "../../components/ui/skeleton";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useSuitePageContext } from "../suitePageContext";
import { AgentsCard, useAgentEntries } from "./AgentsCard";
import { HomeComposer } from "./HomeComposer";
import { useHomeDialogs } from "./HomeSidebar";
import {
  formatRelativeMinutes,
  HOME_MODULES,
  HomeCard,
  type HomeOverviewState,
  SuiteProjectMonogram,
  useHomeOverview,
  useMinuteClock,
} from "./homePresentation";
import { NeedsYouCard } from "./NeedsYouCard";
import { SuggestionsCard } from "./SuggestionsCard";
import { TodayStrip } from "./TodayStrip";
import { useHomeActions } from "./useHomeActions";

const PULSE_PROJECT_KEY = "otterware:home:pulse-project:v1";
const PulseProjectId = Schema.NullOr(Schema.String);

function calendarConnected(overview: SuiteHomeOverview): boolean {
  return overview.contributors.some((status) => status.module === "calendar" && status.ok);
}

/** Loading, failure and "not an Otterware server" states shared by every Home page. */
function HomeFrame({
  state,
  children,
}: {
  readonly state: HomeOverviewState;
  readonly children: (overview: SuiteHomeOverview) => ReactNode;
}) {
  if (state.overview !== null) return children(state.overview);
  if (state.error !== null) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CloudOffIcon />
          </EmptyMedia>
          <EmptyTitle>Home could not load</EmptyTitle>
          <EmptyDescription>{state.error}</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={state.refresh}>
          Try again
        </Button>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-4 p-8">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function summaryLine(
  overview: SuiteHomeOverview,
  running: number,
  nowMs: number,
): ReadonlyArray<ReactNode> {
  const parts: ReactNode[] = [];
  const count = overview.items.length;
  parts.push(
    <span key="needs" className={count > 0 ? "font-medium text-foreground" : undefined}>
      {count === 0
        ? "Nothing needs you"
        : `${count} ${count === 1 ? "thing needs" : "things need"} you`}
    </span>,
  );
  parts.push(
    <span key="agents">
      {running === 0
        ? "no agents working"
        : `${running} ${running === 1 ? "agent" : "agents"} working`}
    </span>,
  );
  const next = overview.today.find((event) => !event.allDay && Date.parse(event.startsAt) > nowMs);
  if (next) {
    parts.push(
      <span key="next">
        next:{" "}
        <span className="font-medium text-foreground">
          {next.title} {formatRelativeMinutes(next.startsAt, nowMs)}
        </span>
      </span>,
    );
  }
  return parts;
}

export function HomeDashboardPage() {
  const state = useHomeOverview();
  const nowMs = useMinuteClock();
  const actions = useHomeActions(state.environmentId, state.refresh);
  const agents = useAgentEntries(state.environmentId, nowMs);
  const navigate = useNavigate();
  useSuitePageContext({ module: "home", title: "Home", refs: [] });

  return (
    <HomeFrame state={state}>
      {(overview) => {
        const running = agents.filter((entry) => entry.state === "running").length;
        const projects = overview.projects.map((entry) => entry.project);
        return (
          <div className="flex min-h-full flex-col lg:flex-row">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex flex-1 flex-col gap-5 px-6 pt-6 pb-4 lg:px-8">
                <div>
                  <h1 className="font-semibold text-xl tracking-tight">
                    {new Date(nowMs).toLocaleDateString(undefined, {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })}
                  </h1>
                  <p className="mt-0.5 text-muted-foreground text-sm">
                    {summaryLine(overview, running, nowMs).flatMap((part, index) =>
                      index === 0 ? [part] : [" · ", part],
                    )}
                  </p>
                </div>
                <TodayStrip
                  events={overview.today}
                  calendarConnected={calendarConnected(overview)}
                  nowMs={nowMs}
                  actions={actions}
                />
                <NeedsYouCard
                  items={overview.items}
                  projects={projects}
                  actions={actions}
                  limit={12}
                />
              </div>
              {state.environmentId !== null ? (
                <div className="sticky bottom-0 z-10 px-6 pb-5 lg:px-8">
                  <HomeComposer
                    environmentId={state.environmentId}
                    projects={projects}
                    actions={actions}
                  />
                </div>
              ) : null}
            </div>
            <aside className="flex w-full shrink-0 flex-col gap-4 border-border/60 px-6 py-6 lg:w-88 lg:border-l lg:px-5">
              <AgentsCard
                entries={agents}
                actions={actions}
                limit={5}
                onShowAll={() => void navigate({ to: "/home/agents" })}
              />
              <SuggestionsCard suggestions={overview.suggestions} nowMs={nowMs} actions={actions} />
              <ProjectPulseCard projects={overview.projects} />
            </aside>
          </div>
        );
      }}
    </HomeFrame>
  );
}

function PulseTiles({ summary }: { readonly summary: SuiteProjectSummary }) {
  const labels = { code: "threads", mail: "mails", calendar: "events", drive: "files" } as const;
  return (
    <div className="grid grid-cols-4 divide-x divide-border/50">
      {HOME_MODULES.map((module) => {
        const Icon = module.icon;
        return (
          <div key={module.id} className="flex flex-col gap-1 px-3 py-3">
            <span className="font-semibold text-lg tabular-nums">{summary.counts[module.id]}</span>
            <span className="flex items-center gap-1 text-muted-foreground text-xs">
              <Icon className="size-3" />
              {labels[module.id]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ProjectPulseCard({ projects }: { readonly projects: ReadonlyArray<SuiteProjectSummary> }) {
  const navigate = useNavigate();
  const dialogs = useHomeDialogs();
  const [selectedId, setSelectedId] = useLocalStorage(PULSE_PROJECT_KEY, null, PulseProjectId);
  const summary = projects.find((entry) => entry.project.id === selectedId) ?? projects[0] ?? null;

  if (summary === null) {
    return (
      <HomeCard.Root aria-label="Project pulse">
        <HomeCard.Header icon={<LayersIcon />} title="Project pulse" />
        <div className="flex flex-col items-start gap-2 px-4 py-4">
          <p className="text-muted-foreground text-sm">
            Group a customer’s or product’s mail, events, files and Code threads into a project to
            see its pulse here.
          </p>
          <Button
            size="xs"
            variant="outline"
            onClick={() => dialogs.openProject({ project: null })}
          >
            New project
          </Button>
        </div>
      </HomeCard.Root>
    );
  }

  return (
    <HomeCard.Root aria-label="Project pulse">
      <HomeCard.Header
        icon={<SuiteProjectMonogram project={summary.project} />}
        title={
          projects.length > 1 ? (
            <Menu>
              <MenuTrigger render={<Button variant="ghost" size="xs" />}>
                {summary.project.name}
                <ChevronDownIcon />
              </MenuTrigger>
              <MenuPopup align="start">
                {projects.map((entry) => (
                  <MenuItem key={entry.project.id} onClick={() => setSelectedId(entry.project.id)}>
                    <SuiteProjectMonogram project={entry.project} />
                    {entry.project.name}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : (
            summary.project.name
          )
        }
        detail="pulse"
        action={
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void navigate({
                to: "/home/projects/$projectId",
                params: { projectId: summary.project.id },
              })
            }
          >
            Open
            <ArrowRightIcon />
          </Button>
        }
      />
      <PulseTiles summary={summary} />
    </HomeCard.Root>
  );
}

export function HomeNeedsYouPage() {
  const state = useHomeOverview();
  const actions = useHomeActions(state.environmentId, state.refresh);
  useSuitePageContext({ module: "home", title: "Needs you", refs: [] });
  return (
    <HomeFrame state={state}>
      {(overview) => (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-6 lg:px-8">
          <NeedsYouCard
            items={overview.items}
            projects={overview.projects.map((entry) => entry.project)}
            actions={actions}
          />
        </div>
      )}
    </HomeFrame>
  );
}

export function HomeAgentsPage() {
  const state = useHomeOverview();
  const nowMs = useMinuteClock();
  const actions = useHomeActions(state.environmentId, state.refresh);
  const agents = useAgentEntries(state.environmentId, nowMs);
  useSuitePageContext({ module: "home", title: "Agents", refs: [] });
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6 lg:px-8">
      <AgentsCard entries={agents} actions={actions} />
    </div>
  );
}

function ProjectRuleSummary({ project }: { readonly project: SuiteProject }) {
  const { rules } = project;
  const parts = [
    rules.code.projectIds.length > 0 ? `${rules.code.projectIds.length} Code project(s)` : null,
    ...rules.mail.domains,
    ...rules.mail.senders,
    ...rules.mail.labels.map((label) => `label ${label}`),
    ...rules.calendar.keywords.map((keyword) => `“${keyword}” events`),
    ...rules.drive.folderSlugs.map((folder) => `/${folder.replace(/^\/+/, "")}`),
  ].filter((part): part is string => part !== null);
  return (
    <p className="text-muted-foreground text-sm">
      {parts.length === 0
        ? "No rules yet: edit the project to choose what belongs to it."
        : parts.join(" · ")}
    </p>
  );
}

export function HomeProjectPage({ projectId }: { readonly projectId: string }) {
  const state = useHomeOverview({ projectId });
  const nowMs = useMinuteClock();
  const actions = useHomeActions(state.environmentId, state.refresh);
  const dialogs = useHomeDialogs();
  const summary = state.overview?.projects.find((entry) => entry.project.id === projectId) ?? null;
  useSuitePageContext({
    module: "home",
    title: summary?.project.name ?? "Project",
    refs: summary ? [{ kind: "suite.project", id: projectId, label: summary.project.name }] : [],
  });

  return (
    <HomeFrame state={state}>
      {(overview) =>
        summary === null ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>Project not found</EmptyTitle>
              <EmptyDescription>It may have been deleted.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex min-h-full flex-col">
            <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-6 pt-6 pb-4 lg:px-8">
              <div className="flex items-start gap-3">
                <SuiteProjectMonogram project={summary.project} className="mt-1 size-6" />
                <div className="min-w-0 flex-1">
                  <h1 className="truncate font-semibold text-xl tracking-tight">
                    {summary.project.name}
                  </h1>
                  <ProjectRuleSummary project={summary.project} />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => dialogs.openProject({ project: summary.project })}
                >
                  <PencilIcon />
                  Edit
                </Button>
              </div>
              <HomeCard.Root aria-label="Pulse">
                <PulseTiles summary={summary} />
              </HomeCard.Root>
              {overview.today.length > 0 ? (
                <TodayStrip
                  events={overview.today}
                  calendarConnected={calendarConnected(overview)}
                  nowMs={nowMs}
                  actions={actions}
                />
              ) : null}
              {HOME_MODULES.map((module) => {
                const items = overview.items.filter((item) => item.module === module.id);
                if (items.length === 0) return null;
                return (
                  <NeedsYouCard
                    key={module.id}
                    title={module.label}
                    detail={`${items.length} need${items.length === 1 ? "s" : ""} you`}
                    items={items}
                    projects={[]}
                    actions={actions}
                  />
                );
              })}
              {overview.items.length === 0 ? (
                <NeedsYouCard
                  items={[]}
                  projects={[]}
                  actions={actions}
                  emptyTitle="Nothing in this project needs you"
                  emptyDescription="Items from its Code projects, senders, calendars and folders show up here."
                />
              ) : null}
              {overview.suggestions.length > 0 ? (
                <SuggestionsCard
                  suggestions={overview.suggestions}
                  nowMs={nowMs}
                  actions={actions}
                />
              ) : null}
            </div>
            {state.environmentId !== null ? (
              <div className="sticky bottom-0 z-10 mx-auto w-full max-w-5xl px-6 pb-5 lg:px-8">
                <HomeComposer
                  key={projectId}
                  environmentId={state.environmentId}
                  projects={overview.projects.map((entry) => entry.project)}
                  initialProjectId={projectId}
                  actions={actions}
                />
              </div>
            ) : null}
          </div>
        )
      }
    </HomeFrame>
  );
}

export function HomeViewPage({ viewId }: { readonly viewId: string }) {
  const state = useHomeOverview({ viewId });
  const actions = useHomeActions(state.environmentId, state.refresh);
  const dialogs = useHomeDialogs();
  const view = state.overview?.views.find((entry) => entry.id === viewId) ?? null;
  useSuitePageContext({
    module: "home",
    title: view?.name ?? "View",
    refs: view ? [{ kind: "suite.view", id: viewId, label: view.name }] : [],
  });

  return (
    <HomeFrame state={state}>
      {(overview) =>
        view === null ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>View not found</EmptyTitle>
              <EmptyDescription>It may have been deleted.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-6 lg:px-8">
            <div className="flex items-start gap-3">
              <LayersIcon className="mt-1.5 size-5 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <h1 className="truncate font-semibold text-xl tracking-tight">{view.name}</h1>
                <p className="text-muted-foreground text-sm">
                  {overview.items.length} {overview.items.length === 1 ? "item" : "items"}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => dialogs.openView(view)}>
                <PencilIcon />
                Edit
              </Button>
            </div>
            <NeedsYouCard
              title={view.name}
              detail="saved view"
              items={overview.items}
              projects={overview.projects.map((entry) => entry.project)}
              actions={actions}
              emptyTitle="Nothing matches this view"
              emptyDescription="Change the filter, or check back when something new comes in."
            />
          </div>
        )
      }
    </HomeFrame>
  );
}
