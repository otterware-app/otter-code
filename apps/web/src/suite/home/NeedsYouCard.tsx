/** Home's ranked "needs you" list across modules, with a module filter. */
import type {
  SuiteHomeItemModule,
  SuiteHomeRankedItem,
  SuiteProject,
} from "@t3tools/contracts/suite";
import { CheckIcon, InboxIcon, SparklesIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { HOME_MODULES, HomeCard, ModuleTile, ProjectChip } from "./homePresentation";
import type { useHomeActions } from "./useHomeActions";

type HomeActions = ReturnType<typeof useHomeActions>;
type Filter = "all" | SuiteHomeItemModule;

export function NeedsYouCard({
  items,
  projects,
  actions,
  title = "Needs you",
  detail = "ranked across apps",
  limit,
  emptyTitle = "Nothing needs you",
  emptyDescription = "Agent questions, approvals, replies and invites show up here.",
}: {
  readonly items: ReadonlyArray<SuiteHomeRankedItem>;
  readonly projects: ReadonlyArray<SuiteProject>;
  readonly actions: HomeActions;
  readonly title?: string;
  readonly detail?: string;
  readonly limit?: number;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const counts = useMemo(() => {
    const byModule = new Map<SuiteHomeItemModule, number>();
    for (const item of items) byModule.set(item.module, (byModule.get(item.module) ?? 0) + 1);
    return byModule;
  }, [items]);
  const visible = (filter === "all" ? items : items.filter((item) => item.module === filter)).slice(
    0,
    limit ?? Number.POSITIVE_INFINITY,
  );
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  return (
    <HomeCard.Root aria-label={title}>
      <HomeCard.Header
        icon={<InboxIcon />}
        title={title}
        detail={detail}
        action={
          items.length > 0 ? (
            <ToggleGroup
              aria-label="Filter by app"
              value={[filter]}
              onValueChange={(values) => setFilter((values[0] as Filter | undefined) ?? "all")}
            >
              <Toggle value="all">All</Toggle>
              {HOME_MODULES.map((module) => (
                <Toggle key={module.id} value={module.id} disabled={!counts.has(module.id)}>
                  {module.label}
                </Toggle>
              ))}
            </ToggleGroup>
          ) : null
        }
      />
      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
          <CheckIcon className="mb-1 size-5 text-muted-foreground" />
          <p className="font-medium text-sm">{emptyTitle}</p>
          <p className="max-w-80 text-muted-foreground text-xs">{emptyDescription}</p>
        </div>
      ) : (
        <HomeCard.Rows>
          {visible.map((item) => (
            <NeedsYouRow
              key={`${item.module}:${item.id}`}
              item={item}
              projects={item.projectIds.flatMap((id) => projectsById.get(id) ?? [])}
              actions={actions}
            />
          ))}
        </HomeCard.Rows>
      )}
    </HomeCard.Root>
  );
}

function NeedsYouRow({
  item,
  projects,
  actions,
}: {
  readonly item: SuiteHomeRankedItem;
  readonly projects: ReadonlyArray<SuiteProject>;
  readonly actions: HomeActions;
}) {
  const ordered = item.actions.toSorted(
    (left, right) => Number(left.primary) - Number(right.primary),
  );
  const when = formatRelativeTimeLabel(item.occurredAt);
  return (
    <div className="group/row relative flex items-center gap-3 px-4 py-3 hover:bg-accent/30">
      <ModuleTile module={item.module} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="block w-full min-w-0 truncate text-left font-medium text-sm outline-none after:absolute after:inset-0 focus-visible:underline"
          onClick={() => actions.openTarget(item.target)}
        >
          {item.title}
        </button>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
          {projects.slice(0, 2).map((project) => (
            <ProjectChip key={project.id} project={project} />
          ))}
          <span className="min-w-0 truncate">
            {[item.subtitle, when].filter(Boolean).join(" · ")}
          </span>
        </div>
        {item.agentNote ? (
          <div className="mt-1 flex min-w-0 items-start gap-1.5 text-primary text-xs">
            <SparklesIcon className="mt-0.5 size-3 shrink-0" />
            <span className="line-clamp-2 min-w-0">{item.agentNote}</span>
          </div>
        ) : null}
      </div>
      {ordered.length > 0 ? (
        <div className="relative z-10 flex shrink-0 items-center gap-1.5">
          {ordered.map((action) => {
            const key = `${item.module}:${item.id}:${action.id}`;
            const pending = actions.pendingKey === key;
            return (
              <Button
                key={action.id}
                size="xs"
                variant={action.primary ? "default" : "outline"}
                disabled={actions.pendingKey !== null}
                onClick={() => void actions.runAction(item, action)}
              >
                {pending ? <Spinner /> : action.id === "approve" ? <CheckIcon /> : null}
                {action.label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
