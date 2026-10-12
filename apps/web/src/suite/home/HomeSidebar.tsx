/**
 * Home's module sidebar: Home, Needs you, Agents; cross-app projects with
 * per-app counts; saved views. Also owns the project and view dialogs, which
 * pages open through `useHomeDialogs`.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { SuiteHomeModuleCounts, SuiteView } from "@t3tools/contracts/suite";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { BotIcon, HouseIcon, InboxIcon, LayersIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";

import { Button } from "../../components/ui/button";
import { CollapsibleSectionHeader } from "../../components/ui/collapsible-section-header";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../../components/ui/sidebar";
import { useProjects } from "../../state/entities";
import { useAgentEntries } from "./AgentsCard";
import { type ProjectDialogSeed, ProjectDialog, ViewDialog } from "./HomeDialogs";
import { refreshHomeOverviews } from "./homeRpc";
import {
  HOME_MODULES,
  SuiteProjectMonogram,
  useHomeOverview,
  useMinuteClock,
} from "./homePresentation";

interface HomeDialogsState {
  readonly project: ProjectDialogSeed | null;
  /** undefined: closed; null: new view. */
  readonly view: SuiteView | null | undefined;
  readonly openProject: (seed: ProjectDialogSeed | null) => void;
  readonly openView: (view: SuiteView | null | undefined) => void;
}

export const useHomeDialogs = create<HomeDialogsState>((set) => ({
  project: null,
  view: undefined,
  openProject: (project) => set({ project }),
  openView: (view) => set({ view }),
}));

function ModuleCounts({ counts }: { readonly counts: SuiteHomeModuleCounts }) {
  return (
    <span className="ms-auto flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground tabular-nums">
      {HOME_MODULES.filter((module) => counts[module.id] > 0).map((module) => {
        const Icon = module.icon;
        return (
          <span
            key={module.id}
            className="inline-flex items-center gap-0.5"
            aria-label={`${counts[module.id]} ${module.label}`}
          >
            <Icon className="size-3" />
            {counts[module.id]}
          </span>
        );
      })}
    </span>
  );
}

export function HomeSidebar() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environmentId, overview } = useHomeOverview();
  const agents = useAgentEntries(environmentId, useMinuteClock());
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [viewsOpen, setViewsOpen] = useState(true);
  const dialogs = useHomeDialogs();
  const codeProjects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      !(
        project.title === "Otterware Assistant" && project.workspaceRoot.endsWith("agent-workspace")
      ),
  );
  const projects = overview?.projects ?? [];
  const views = overview?.views ?? [];
  const running = agents.filter((entry) => entry.state === "running").length;

  return (
    <>
      <SidebarGroup>
        <SidebarMenu>
          <NavRow
            icon={<HouseIcon />}
            label="Home"
            active={pathname === "/home" || pathname === "/home/"}
            onClick={() => void navigate({ to: "/home" })}
          />
          <NavRow
            icon={<InboxIcon />}
            label="Needs you"
            detail={overview && overview.items.length > 0 ? String(overview.items.length) : null}
            active={pathname === "/home/needs-you"}
            onClick={() => void navigate({ to: "/home/needs-you" })}
          />
          <NavRow
            icon={<BotIcon />}
            label="Agents"
            detail={running > 0 ? `${running} running` : null}
            active={pathname === "/home/agents"}
            onClick={() => void navigate({ to: "/home/agents" })}
          />
        </SidebarMenu>
      </SidebarGroup>

      <SidebarGroup>
        <div className="flex items-center gap-0.5">
          <div className="min-w-0 flex-1">
            <CollapsibleSectionHeader
              expanded={projectsOpen}
              onClick={() => setProjectsOpen((open) => !open)}
            >
              Projects
            </CollapsibleSectionHeader>
          </div>
          <Menu>
            <MenuTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label="New project" />}
            >
              <PlusIcon />
            </MenuTrigger>
            <MenuPopup align="start" className="max-h-96">
              <MenuItem onClick={() => dialogs.openProject({ project: null })}>
                New project
              </MenuItem>
              {codeProjects.length > 0 ? (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>From a Code project</MenuGroupLabel>
                    {codeProjects.map((project) => (
                      <MenuItem
                        key={project.id}
                        onClick={() =>
                          dialogs.openProject({
                            project: null,
                            name: project.title,
                            codeProjectIds: [project.id],
                          })
                        }
                      >
                        {project.title}
                      </MenuItem>
                    ))}
                  </MenuGroup>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        </div>
        {projectsOpen ? (
          projects.length === 0 ? (
            <p className="px-2 py-1 text-muted-foreground text-xs">
              Group a customer’s or product’s mail, events, files and code.
            </p>
          ) : (
            <SidebarMenu>
              {projects.map(({ project, counts }) => (
                <NavRow
                  key={project.id}
                  icon={<SuiteProjectMonogram project={project} />}
                  label={project.name}
                  trailing={<ModuleCounts counts={counts} />}
                  active={pathname === `/home/projects/${project.id}`}
                  onClick={() =>
                    void navigate({
                      to: "/home/projects/$projectId",
                      params: { projectId: project.id },
                    })
                  }
                />
              ))}
            </SidebarMenu>
          )
        ) : null}
      </SidebarGroup>

      <SidebarGroup>
        <div className="flex items-center gap-0.5">
          <div className="min-w-0 flex-1">
            <CollapsibleSectionHeader
              expanded={viewsOpen}
              onClick={() => setViewsOpen((open) => !open)}
            >
              Views
            </CollapsibleSectionHeader>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="New view"
            onClick={() => dialogs.openView(null)}
          >
            <PlusIcon />
          </Button>
        </div>
        {viewsOpen ? (
          views.length === 0 ? (
            <p className="px-2 py-1 text-muted-foreground text-xs">
              Save a filter, like “waiting on me” or “this week across apps”.
            </p>
          ) : (
            <SidebarMenu>
              {views.map((view) => (
                <NavRow
                  key={view.id}
                  icon={<LayersIcon />}
                  label={view.name}
                  active={pathname === `/home/views/${view.id}`}
                  onClick={() =>
                    void navigate({ to: "/home/views/$viewId", params: { viewId: view.id } })
                  }
                />
              ))}
            </SidebarMenu>
          )
        ) : null}
      </SidebarGroup>

      {environmentId !== null ? (
        <HomeDialogHost
          environmentId={environmentId}
          projects={projects.map((entry) => entry.project)}
        />
      ) : null}
    </>
  );
}

function NavRow(props: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly detail?: string | null;
  readonly trailing?: React.ReactNode;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={props.active} onClick={props.onClick}>
        {props.icon}
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {props.trailing ??
          (props.detail ? (
            <span className="ms-auto shrink-0 font-normal text-2xs text-muted-foreground tabular-nums">
              {props.detail}
            </span>
          ) : null)}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function HomeDialogHost({
  environmentId,
  projects,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: Parameters<typeof ViewDialog>[0]["projects"];
}) {
  const navigate = useNavigate();
  const dialogs = useHomeDialogs();
  return (
    <>
      <ProjectDialog
        environmentId={environmentId}
        seed={dialogs.project}
        onOpenChange={(open) => {
          if (!open) dialogs.openProject(null);
        }}
        onSaved={(project) => {
          const created = dialogs.project?.project === null;
          dialogs.openProject(null);
          refreshHomeOverviews();
          if (project === null) void navigate({ to: "/home" });
          else if (created) {
            void navigate({ to: "/home/projects/$projectId", params: { projectId: project.id } });
          }
        }}
      />
      <ViewDialog
        environmentId={environmentId}
        view={dialogs.view}
        projects={projects}
        onOpenChange={(open) => {
          if (!open) dialogs.openView(undefined);
        }}
        onSaved={(view) => {
          const created = dialogs.view === null;
          dialogs.openView(undefined);
          refreshHomeOverviews();
          if (view === null) void navigate({ to: "/home" });
          else if (created)
            void navigate({ to: "/home/views/$viewId", params: { viewId: view.id } });
        }}
      />
    </>
  );
}
