/**
 * The sidebar while Projects is picked in the rail (ChatGPT's projects): its
 * heading with Search, New project, then every active project's conversations together,
 * each active project, and the settled ones folded at the end. Conversations
 * dragged from the list drop onto a project to join it.
 */

import { useState } from "react";
import { CircleCheckIcon, FolderClosedIcon, FolderPlusIcon } from "lucide-react";

import { cn } from "./ui";
import {
  NewRow,
  SearchButton,
  Section,
  SectionAddButton,
  SidebarBody,
  SkRow,
  SpaceHeading,
} from "./sidebar-ui";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./menu";
import { requestNewProject } from "./project-menus";
import {
  ALL_PROJECTS,
  projectsApi,
  useProjectUnreadCounts,
  useProjects,
  type Project,
} from "./projects";
import { isThreadDrag, readThreadDrag } from "./thread-drag";
import { toast } from "./toast";

function ProjectRow({
  project,
  selected,
  unread,
  onSelect,
}: {
  project: Project;
  selected: boolean;
  unread: number;
  onSelect: () => void;
}) {
  const [dropActive, setDropActive] = useState(false);
  const settled = project.status === "settled";
  const count = project.threads.length;
  const addDropped = (threads: { accountId: string; threadId: string }[]) => {
    console.log("[ProjectsSidebar:dropThreads]", { count: threads.length });
    projectsApi.addThreads(project.id, threads).then(
      () =>
        toast.success(
          threads.length === 1
            ? `Added to “${project.name}”`
            : `Added ${threads.length} conversations to “${project.name}”`,
        ),
      () => toast.error("Couldn't add to the project"),
    );
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        {/* Two lines (ChatGPT's Scheduled): the name, then how it stands. */}
        <button
          type="button"
          onClick={onSelect}
          onDragOver={(e) => {
            if (!isThreadDrag(e.dataTransfer)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDropActive(true);
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={(e) => {
            setDropActive(false);
            const payload = readThreadDrag(e.dataTransfer);
            if (!payload) return;
            e.preventDefault();
            addDropped(payload.threads);
          }}
          className={cn(
            "flex w-full flex-col rounded-lg px-(--sidebar-row-content-inset) py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
            selected
              ? "bg-sidebar-row-selected text-sidebar-foreground"
              : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            dropActive && "bg-sidebar-row-hover ring-1 ring-inset ring-primary/70",
          )}
        >
          <span className="truncate text-sm">{project.name}</span>
          <span className="truncate text-[13px] text-sidebar-muted-foreground">
            {settled && project.settledAt
              ? `Settled ${new Date(project.settledAt).toLocaleDateString([], { month: "short", day: "numeric" })}`
              : [
                  `${count} conversation${count === 1 ? "" : "s"}`,
                  unread > 0 ? `${unread} unread` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          icon={settled ? undefined : <CircleCheckIcon />}
          onSelect={() =>
            void projectsApi.update(project.id, { status: settled ? "active" : "settled" })
          }
        >
          {settled ? "Reopen" : "Settle"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function ProjectsSidebar({
  selectedLabelId,
  onSelectLabel,
  searchSelected,
  searchPending,
  onOpenSearch,
}: {
  /** ALL_PROJECTS, a project's id, or Search. */
  selectedLabelId: string;
  onSelectLabel: (labelId: string) => void;
  searchSelected: boolean;
  searchPending: boolean;
  onOpenSearch: () => void;
}) {
  const projects = useProjects().data ?? [];
  const unread = useProjectUnreadCounts().data ?? {};
  const active = projects
    .filter((p) => p.status === "active")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const settled = projects
    .filter((p) => p.status === "settled")
    .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
  const allUnread = active.reduce((sum, p) => sum + (unread[p.id] ?? 0), 0);
  const row = (project: Project) => (
    <ProjectRow
      key={project.id}
      project={project}
      selected={selectedLabelId === project.id}
      unread={unread[project.id] ?? 0}
      onSelect={() => onSelectLabel(project.id)}
    />
  );

  return (
    <div className="flex h-full min-w-0 flex-col">
      <SpaceHeading title="Projects">
        <SearchButton selected={searchSelected} pending={searchPending} onClick={onOpenSearch} />
      </SpaceHeading>

      <NewRow
        icon={<FolderPlusIcon />}
        label="New project"
        onClick={() => requestNewProject({ open: true })}
      />

      <SidebarBody>
        <SkRow
          icon={<FolderClosedIcon className="size-4" />}
          title="All projects"
          selected={selectedLabelId === ALL_PROJECTS}
          badge={allUnread}
          onClick={() => onSelectLabel(ALL_PROJECTS)}
        />
        <Section
          title="Active"
          action={
            <SectionAddButton
              label="New project"
              onClick={() => requestNewProject({ open: true })}
            />
          }
        >
          {active.length > 0 ? (
            active.map(row)
          ) : (
            <p className="px-(--sidebar-row-content-inset) py-1.5 text-sm text-sidebar-muted-foreground/70">
              No projects
            </p>
          )}
        </Section>
        {settled.length > 0 ? (
          <Section title="Settled" defaultOpen={false}>
            {settled.map(row)}
          </Section>
        ) : null}
      </SidebarBody>
    </div>
  );
}
