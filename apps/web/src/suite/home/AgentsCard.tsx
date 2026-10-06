/**
 * Agents across Code threads: waiting on the user, running, and recently
 * finished, read live from this client's thread shells (the same state the
 * sidebar shows), with the sidebar's status colors.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import { useMemo } from "react";

import { resolveThreadStatusPill } from "../../components/Sidebar.logic";
import { cn } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { HomeCard } from "./homePresentation";
import type { useHomeActions } from "./useHomeActions";

const DAY_MS = 24 * 60 * 60 * 1000;

export type AgentState = "waiting" | "running" | "finished";

export interface AgentEntry {
  readonly shell: EnvironmentThreadShell;
  readonly state: AgentState;
  readonly since: string;
}

/** Root threads that are waiting, running, or finished in the last day; newest first per state. */
export function useAgentEntries(environmentId: EnvironmentId | null, nowMs: number) {
  const shells = useThreadShells();
  return useMemo(() => {
    const entries: AgentEntry[] = [];
    for (const shell of shells) {
      if (environmentId !== null && shell.environmentId !== environmentId) continue;
      if (shell.archivedAt !== null) continue;
      if (
        shell.lineage.relationshipToParent === "subagent" &&
        !shell.hasPendingApprovals &&
        !shell.hasPendingUserInput
      )
        continue;
      if (shell.hasPendingApprovals || shell.hasPendingUserInput) {
        entries.push({ shell, state: "waiting", since: shell.updatedAt });
      } else if (threadRuntimeIsActive(shell.runtime)) {
        entries.push({
          shell,
          state: "running",
          since: shell.runtime?.activityStartedAt ?? shell.latestRun?.startedAt ?? shell.updatedAt,
        });
      } else if (shell.latestRun?.completedAt) {
        const completed = Date.parse(shell.latestRun.completedAt);
        if (!Number.isNaN(completed) && nowMs - completed <= DAY_MS) {
          entries.push({ shell, state: "finished", since: shell.latestRun.completedAt });
        }
      }
    }
    const order: Record<AgentState, number> = { waiting: 0, running: 1, finished: 2 };
    return entries.toSorted(
      (left, right) =>
        order[left.state] - order[right.state] || right.since.localeCompare(left.since),
    );
  }, [environmentId, nowMs, shells]);
}

export function AgentsCard({
  entries,
  actions,
  limit,
  onShowAll,
}: {
  readonly entries: ReadonlyArray<AgentEntry>;
  readonly actions: ReturnType<typeof useHomeActions>;
  readonly limit?: number;
  readonly onShowAll?: () => void;
}) {
  const projects = useProjects();
  const projectTitles = useMemo(
    () =>
      new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project.title])),
    [projects],
  );
  const running = entries.filter((entry) => entry.state === "running").length;
  const visible = limit === undefined ? entries : entries.slice(0, limit);

  return (
    <HomeCard.Root aria-label="Agents">
      <HomeCard.Header
        icon={<BotIcon />}
        title="Agents"
        detail={running > 0 ? `${running} running` : undefined}
        action={
          onShowAll && limit !== undefined && entries.length > limit ? (
            <button
              type="button"
              className="text-muted-foreground text-xs hover:text-foreground"
              onClick={onShowAll}
            >
              All {entries.length}
            </button>
          ) : null
        }
      />
      {visible.length === 0 ? (
        <p className="px-4 py-5 text-muted-foreground text-sm">
          No agents working right now. Threads you start show up here.
        </p>
      ) : (
        <HomeCard.Rows>
          {visible.map(({ shell, state, since }) => {
            const pill = resolveThreadStatusPill({ thread: shell });
            const label =
              state === "finished"
                ? `Finished ${formatRelativeTimeLabel(since)}`
                : state === "running"
                  ? `${pill?.label ?? "Working"} · ${formatRelativeTimeLabel(since).replace(" ago", "")}`
                  : (pill?.label ?? "Waiting on you");
            return (
              <button
                key={`${shell.environmentId}:${shell.id}`}
                type="button"
                className="flex w-full items-start gap-3 px-4 py-2.5 text-left outline-none hover:bg-accent/30 focus-visible:bg-accent/40"
                onClick={() => actions.openThread(scopeThreadRef(shell.environmentId, shell.id))}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    pill?.dotClass ?? "bg-success",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sm">{shell.title}</span>
                  <span className="block truncate text-muted-foreground text-xs">
                    <span className={pill?.colorClass}>{label}</span>
                    {" · "}
                    {projectTitles.get(`${shell.environmentId}:${shell.projectId}`) ?? "Code"}
                  </span>
                </span>
              </button>
            );
          })}
        </HomeCard.Rows>
      )}
    </HomeCard.Root>
  );
}
