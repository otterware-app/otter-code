/**
 * Today's events from the calendar contributor, the next one highlighted with
 * a "Prep brief" button that starts an agent gathering mail, Drive and Code
 * context for it. Briefs are remembered per event, so the card shows when one
 * is being prepared or ready.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SuiteHomeTodayEntry } from "@t3tools/contracts/suite";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ArrowRightIcon, CalendarDaysIcon, SparklesIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { formatClock, formatRelativeMinutes, HomeCard } from "./homePresentation";
import type { useHomeActions } from "./useHomeActions";

type HomeActions = ReturnType<typeof useHomeActions>;

const BRIEFS_KEY = "otterware:home:event-briefs:v1";
const Briefs = Schema.Record(
  Schema.String,
  Schema.Struct({ environmentId: Schema.String, threadId: Schema.String }),
);

export function briefPrompt(event: SuiteHomeTodayEntry): string {
  return [
    `Prepare a short brief for my meeting “${event.title}” at ${formatClock(event.startsAt)} (calendar event ${event.id}).`,
    "Use the calendar tools to read the event and its attendees, search mail for recent threads with them or about the topic, and find related Drive docs and Code threads.",
    "Write one page: the purpose, who is coming, open questions, related threads and docs with links, and what I should decide or prepare.",
  ].join(" ");
}

export function TodayStrip({
  events,
  calendarConnected,
  nowMs,
  actions,
}: {
  readonly events: ReadonlyArray<SuiteHomeTodayEntry>;
  readonly calendarConnected: boolean;
  readonly nowMs: number;
  readonly actions: HomeActions;
}) {
  const navigate = useNavigate();
  const [briefs, setBriefs] = useLocalStorage(BRIEFS_KEY, {}, Briefs);
  const next = events.find((event) => !event.allDay && Date.parse(event.endsAt) > nowMs) ?? null;
  const calendars = new Set(events.flatMap((event) => event.calendarName ?? []));

  const prepBrief = async (event: SuiteHomeTodayEntry) => {
    const ref = await actions.startThread({
      key: `brief:${event.id}`,
      title: `Brief: ${event.title}`,
      prompt: briefPrompt(event),
      context: {
        module: "calendar",
        title: event.title,
        refs: [{ kind: "calendar.event", id: event.id, label: event.title }],
      },
    });
    if (ref)
      setBriefs({
        ...briefs,
        [event.id]: { environmentId: ref.environmentId, threadId: ref.threadId },
      });
  };

  return (
    <HomeCard.Root aria-label="Today">
      <HomeCard.Header
        icon={<CalendarDaysIcon />}
        title="Today"
        detail={
          calendars.size > 0
            ? `${calendars.size} ${calendars.size === 1 ? "calendar" : "calendars"}`
            : undefined
        }
        action={
          calendarConnected ? (
            <Button size="xs" variant="ghost" onClick={() => void navigate({ to: "/calendar" })}>
              Open calendar
              <ArrowRightIcon />
            </Button>
          ) : null
        }
      />
      {events.length === 0 ? (
        <p className="px-4 py-5 text-muted-foreground text-sm">
          {calendarConnected
            ? "Nothing on your calendar for the rest of today."
            : "Connect Calendar to see your day here."}
        </p>
      ) : (
        <div className="flex gap-2 overflow-x-auto p-3">
          {events.map((event) => {
            const isNext = event.id === next?.id;
            const past = !event.allDay && Date.parse(event.endsAt) <= nowMs;
            const brief = briefs[event.id];
            return (
              <div
                key={event.id}
                className={cn(
                  "relative flex w-48 shrink-0 flex-col gap-1 rounded-lg border px-3 py-2.5",
                  isNext ? "border-success/40 bg-success/6" : "border-border/60 bg-background/40",
                  past && "opacity-55",
                )}
              >
                <span
                  aria-hidden
                  className="absolute inset-y-2.5 left-0 w-0.5 rounded-full"
                  style={{ backgroundColor: event.color ?? "var(--color-border)" }}
                />
                <button
                  type="button"
                  className="min-w-0 text-left outline-none after:absolute after:inset-0 focus-visible:underline"
                  onClick={() => actions.openTarget(event.target)}
                >
                  <span
                    className={cn(
                      "block text-xs",
                      isNext ? "text-success-foreground" : "text-muted-foreground",
                    )}
                  >
                    {event.allDay
                      ? "All day"
                      : isNext && Date.parse(event.startsAt) > nowMs
                        ? `${formatRelativeMinutes(event.startsAt, nowMs)} · ${formatClock(event.startsAt)}`
                        : `${formatClock(event.startsAt)} – ${formatClock(event.endsAt)}`}
                  </span>
                  <span className="mt-0.5 block truncate font-medium text-sm">{event.title}</span>
                  {event.location || event.calendarName ? (
                    <span className="block truncate text-muted-foreground text-xs">
                      {event.location ?? event.calendarName}
                    </span>
                  ) : null}
                </button>
                {brief ? (
                  <BriefStatus brief={brief} onOpen={actions.openThread} />
                ) : isNext ? (
                  <Button
                    size="xs"
                    variant="outline"
                    className="relative z-10 mt-1 self-start"
                    disabled={actions.pendingKey !== null}
                    onClick={() => void prepBrief(event)}
                  >
                    {actions.pendingKey === `brief:${event.id}` ? <Spinner /> : <SparklesIcon />}
                    Prep brief
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </HomeCard.Root>
  );
}

function BriefStatus({
  brief,
  onOpen,
}: {
  readonly brief: { readonly environmentId: string; readonly threadId: string };
  readonly onOpen: HomeActions["openThread"];
}) {
  const ref = scopeThreadRef(
    EnvironmentId.make(brief.environmentId),
    ThreadId.make(brief.threadId),
  );
  const shell = useThreadShell(ref);
  const working =
    shell !== null &&
    (shell.runtime?.activeRunId != null ||
      shell.latestRun?.status === "running" ||
      shell.latestRun?.status === "starting" ||
      shell.latestRun?.status === "queued");
  return (
    <Button
      size="xs"
      variant="outline"
      className="relative z-10 mt-1 self-start"
      onClick={() => onOpen(ref)}
    >
      {working ? <Spinner /> : <SparklesIcon />}
      {working ? "Preparing brief" : "Brief ready"}
    </Button>
  );
}
