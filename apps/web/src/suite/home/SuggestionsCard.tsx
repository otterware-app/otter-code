/**
 * "Suggested next": the server's rule-based cross-app steps. Starting one opens
 * a Code thread with the prepared prompt; "Later" hides it for a day.
 */
import type { SuiteHomeSuggestion } from "@t3tools/contracts/suite";
import * as Schema from "effect/Schema";
import { ArrowRightIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { homeModule, HomeCard } from "./homePresentation";
import type { useHomeActions } from "./useHomeActions";

const DISMISSED_KEY = "otterware:home:dismissed-suggestions:v1";
const DAY_MS = 24 * 60 * 60 * 1000;
const Dismissed = Schema.Record(Schema.String, Schema.Number);

export function SuggestionsCard({
  suggestions,
  nowMs,
  actions,
}: {
  readonly suggestions: ReadonlyArray<SuiteHomeSuggestion>;
  readonly nowMs: number;
  readonly actions: ReturnType<typeof useHomeActions>;
}) {
  const [dismissed, setDismissed] = useLocalStorage(DISMISSED_KEY, {}, Dismissed);
  const visible = suggestions.filter((entry) => (dismissed[entry.id] ?? 0) < nowMs);

  return (
    <HomeCard.Root aria-label="Suggested next">
      <HomeCard.Header icon={<ArrowRightIcon />} title="Suggested next" />
      {visible.length === 0 ? (
        <p className="px-4 py-5 text-muted-foreground text-sm">
          Nothing to suggest. Ideas that connect your mail, calendar, files and code show up here.
        </p>
      ) : (
        <HomeCard.Rows>
          {visible.map((suggestion) => {
            const from = homeModule(suggestion.from);
            const to = homeModule(suggestion.to);
            const FromIcon = from.icon;
            const ToIcon = to.icon;
            const key = `suggestion:${suggestion.id}`;
            return (
              <div key={suggestion.id} className="flex flex-col gap-1.5 px-4 py-3">
                <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
                  <FromIcon className={`size-3 ${from.className}`} />
                  {from.label}
                  <ArrowRightIcon className="size-3" />
                  <ToIcon className={`size-3 ${to.className}`} />
                  {to.label}
                </div>
                <p className="font-medium text-sm leading-snug">{suggestion.title}</p>
                <p className="text-muted-foreground text-xs">{suggestion.reason}</p>
                <div className="mt-1 flex gap-1.5">
                  <Button
                    size="xs"
                    disabled={actions.pendingKey !== null}
                    onClick={() =>
                      void actions.startThread({
                        key,
                        prompt: suggestion.action.prompt,
                        title: suggestion.title,
                        codeProjectId: suggestion.action.codeProjectId ?? null,
                        context: { module: suggestion.from, title: suggestion.title, refs: [] },
                      })
                    }
                  >
                    {actions.pendingKey === key ? <Spinner /> : null}
                    {suggestion.action.label}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setDismissed({ ...dismissed, [suggestion.id]: nowMs + DAY_MS })}
                  >
                    Later
                  </Button>
                </div>
              </div>
            );
          })}
        </HomeCard.Rows>
      )}
    </HomeCard.Root>
  );
}
