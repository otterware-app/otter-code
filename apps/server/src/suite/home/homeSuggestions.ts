/**
 * Home's "Suggested next": a few explainable rules that connect apps. Each
 * suggestion names its rule and why it fired, and carries a ready prompt; the
 * client starts a Code thread with it. Rules only fire when the module that
 * would do the work is running, so a suggestion never asks for tools that
 * are not there.
 */
import type {
  SuiteHomeItemModule,
  SuiteHomeRankedItem,
  SuiteHomeSuggestion,
  SuiteHomeTodayEntry,
  SuiteProject,
} from "@t3tools/contracts/suite";

/** A pull request an agent's thread linked, merged recently. */
export interface MergedPullRequestFact {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly codeProjectId: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly mergedAt: string;
}

export interface SuggestionInput {
  readonly items: ReadonlyArray<SuiteHomeRankedItem>;
  readonly today: ReadonlyArray<SuiteHomeTodayEntry>;
  readonly projects: ReadonlyArray<SuiteProject>;
  readonly mergedPullRequests: ReadonlyArray<MergedPullRequestFact>;
  /** Modules whose tools agents can use right now (code is always there). */
  readonly modules: ReadonlySet<SuiteHomeItemModule>;
  readonly nowMs: number;
}

export const MAX_SUGGESTIONS = 5;
const HOUR_MS = 60 * 60 * 1000;

/** Words that make an email read like a problem report. */
const PROBLEM_PATTERN =
  /\b(bugs?|errors?|crash(?:es|ed|ing)?|broken|fails?|failing|failed|exceptions?|regressions?|not working|doesn'?t work|does not work|can'?t log ?in)\b/i;

const quote = (text: string) => `“${text.length > 90 ? `${text.slice(0, 89)}…` : text}”`;

const senderOf = (item: SuiteHomeRankedItem) => item.facets?.senders?.[0];

/** The one Code project a set of cross-app projects points at, if exactly one. */
function codeProjectFor(
  projectIds: ReadonlyArray<string>,
  projects: ReadonlyArray<SuiteProject>,
): string | undefined {
  const codeProjectIds = new Set(
    projects
      .filter((project) => projectIds.includes(project.id))
      .flatMap((project) => project.rules.code.projectIds),
  );
  return codeProjectIds.size === 1 ? [...codeProjectIds][0] : undefined;
}

/** "in 25 min" / "in 3 h": relative, so server and client time zones never disagree. */
const startsIn = (startsMs: number, nowMs: number) => {
  const minutes = Math.max(0, Math.round((startsMs - nowMs) / 60_000));
  return minutes < 60 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)} h`;
};

function mailBugToCode(input: SuggestionInput): Array<SuiteHomeSuggestion> {
  return input.items
    .filter(
      (item) =>
        item.module === "mail" && PROBLEM_PATTERN.test(`${item.title} ${item.subtitle ?? ""}`),
    )
    .map((item) => {
      const sender = senderOf(item);
      const codeProjectId = codeProjectFor(item.projectIds, input.projects);
      return {
        id: `mail-bug-to-code:${item.id}`,
        rule: "mail-bug-to-code",
        from: "mail",
        to: "code",
        title: `${quote(item.title)}${sender ? ` from ${sender}` : ""}: start a fix?`,
        reason: "This email reads like a problem report.",
        action: {
          label: "Start thread",
          prompt: [
            `An email reports a problem: ${quote(item.title)}${sender ? ` from ${sender}` : ""}.`,
            `Read it with the mail tools (Home item ${item.id}), find the code involved and explain the likely cause.`,
            "Propose a fix and ask me before changing anything.",
          ].join(" "),
          ...(codeProjectId === undefined ? {} : { codeProjectId }),
        },
        projectIds: item.projectIds,
      } satisfies SuiteHomeSuggestion;
    });
}

function eventNotesToDrive(input: SuggestionInput): Array<SuiteHomeSuggestion> {
  if (!input.modules.has("drive")) return [];
  const { nowMs } = input;
  return input.today
    .filter((event) => {
      if (event.allDay) return false;
      const startsMs = Date.parse(event.startsAt);
      if (Number.isNaN(startsMs) || startsMs < nowMs || startsMs - nowMs > 24 * HOUR_MS) {
        return false;
      }
      return (event.facets?.driveFileIds ?? []).length === 0;
    })
    .slice(0, 2)
    .map(
      (event) =>
        ({
          id: `event-notes-to-drive:${event.id}`,
          rule: "event-notes-to-drive",
          from: "calendar",
          to: "drive",
          title: `Draft notes for ${quote(event.title)} in Drive`,
          reason: `Starts ${startsIn(Date.parse(event.startsAt), nowMs)} and has no linked notes doc.`,
          action: {
            label: "Draft notes",
            prompt: [
              `Prepare a notes doc for the meeting ${quote(event.title)} (starts ${event.startsAt}).`,
              `Read the event with the calendar tools (event ${event.id}) and its attendees,`,
              "gather related mail threads and Code threads,",
              "then create the notes document in Drive and link it to the event.",
            ].join(" "),
          },
          projectIds: event.projectIds,
        }) satisfies SuiteHomeSuggestion,
    );
}

function mergedPullRequestReply(input: SuggestionInput): Array<SuiteHomeSuggestion> {
  if (!input.modules.has("mail")) return [];
  const { nowMs } = input;
  const suggestions: Array<SuiteHomeSuggestion> = [];
  for (const pullRequest of input.mergedPullRequests) {
    const mergedMs = Date.parse(pullRequest.mergedAt);
    if (Number.isNaN(mergedMs) || nowMs - mergedMs > 7 * 24 * HOUR_MS) continue;
    const projectIds = new Set(
      input.projects
        .filter((project) => project.rules.code.projectIds.includes(pullRequest.codeProjectId))
        .map((project) => project.id),
    );
    const mail = input.items.find(
      (item) => item.module === "mail" && item.projectIds.some((id) => projectIds.has(id)),
    );
    if (mail === undefined) continue;
    const sender = senderOf(mail);
    suggestions.push({
      id: `merged-pr-reply:${pullRequest.repository}#${pullRequest.number}:${mail.id}`,
      rule: "merged-pr-reply",
      from: "code",
      to: "mail",
      title: `PR #${pullRequest.number} shipped: let ${sender ?? "them"} know?`,
      reason: `${quote(pullRequest.title)} was merged and the same project has an open email.`,
      action: {
        label: "Draft reply",
        prompt: [
          `Pull request #${pullRequest.number} ${quote(pullRequest.title)} (${pullRequest.url}) was merged.`,
          `Draft a reply to the email ${quote(mail.title)} (Home item ${mail.id}) saying the fix shipped and what changed.`,
          "Save it as a draft; do not send it.",
        ].join(" "),
      },
      projectIds: mail.projectIds,
    });
  }
  return suggestions;
}

/** All rules, deduplicated by id, capped at `MAX_SUGGESTIONS` in rule order. */
export function suggestNext(input: SuggestionInput): Array<SuiteHomeSuggestion> {
  const seen = new Set<string>();
  return [...mergedPullRequestReply(input), ...mailBugToCode(input), ...eventNotesToDrive(input)]
    .filter((suggestion) => {
      if (seen.has(suggestion.id)) return false;
      seen.add(suggestion.id);
      return true;
    })
    .slice(0, MAX_SUGGESTIONS);
}
