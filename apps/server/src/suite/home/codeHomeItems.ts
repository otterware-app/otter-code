/**
 * Turns Otter Code's thread shells into Home items, the agents summary, and the
 * facts Home's suggestion rules read. Pure, so the rules are testable without
 * an orchestrator; `CodeHomeActivity` feeds it from the projections.
 */
import type {
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import type {
  SuiteHomeAgentsSummary,
  SuiteHomeItem,
  SuiteHomeItemAction,
} from "@t3tools/contracts/suite";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";

import type { MergedPullRequestFact } from "./homeSuggestions.ts";

/** What the approval or question a thread waits on says, read from its turn items. */
export interface PendingRequestDetail {
  readonly requestId: string;
  /** The command, file, or question text. */
  readonly text: string | null;
}

export interface CodeHomeSnapshot {
  readonly items: ReadonlyArray<SuiteHomeItem>;
  readonly agents: SuiteHomeAgentsSummary;
  readonly activeThreadsByCodeProject: ReadonlyMap<string, number>;
  readonly mergedPullRequests: ReadonlyArray<MergedPullRequestFact>;
}

/** Item ids encode what an action needs, so `performAction` can act without a lookup table. */
export const codeItemId = {
  request: (threadId: string, requestId: string) =>
    `request:${encodeURIComponent(threadId)}:${encodeURIComponent(requestId)}`,
  finished: (threadId: string) => `finished:${encodeURIComponent(threadId)}`,
  failed: (threadId: string) => `failed:${encodeURIComponent(threadId)}`,
  pullRequest: (threadId: string, repository: string, number: number) =>
    `pr:${encodeURIComponent(threadId)}:${repository}#${number}`,
};

export function parseCodeItemId(
  itemId: string,
):
  | { readonly kind: "request"; readonly threadId: string; readonly requestId: string }
  | { readonly kind: "finished" | "failed" | "pr"; readonly threadId: string }
  | null {
  const [kind, threadId, ...rest] = itemId.split(":");
  if (threadId === undefined || threadId.length === 0) return null;
  try {
    const decodedThreadId = decodeURIComponent(threadId);
    if (kind === "request" && rest.join(":").length > 0) {
      return { kind, threadId: decodedThreadId, requestId: decodeURIComponent(rest.join(":")) };
    }
    if (kind === "finished" || kind === "failed" || kind === "pr")
      return { kind, threadId: decodedThreadId };
  } catch {
    return null;
  }
  return null;
}

const HOUR_MS = 60 * 60 * 1000;
const RECENTLY_FINISHED_MS = 24 * HOUR_MS;
const MERGED_FACT_WINDOW_MS = 7 * 24 * HOUR_MS;

const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running"]);
const APPROVAL_KINDS = new Set(["command", "file-read", "file-change", "permission"]);

const millis = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);
const iso = (value: DateTime.Utc) => DateTime.formatIso(value);

const truncate = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const threadTarget = (threadId: string) => ({
  // The client fills `$environmentId` with the environment the overview came from.
  route: "/$environmentId/$threadId",
  params: { threadId },
});

const openThread = (threadId: string, primary: boolean, label = "Open thread") =>
  ({
    id: "open",
    label,
    ...(primary ? { primary: true } : {}),
    target: threadTarget(threadId),
  }) satisfies SuiteHomeItemAction;

const requestTitle = (kind: string, detail: string | null) => {
  if (kind === "user_input")
    return detail ? `Agent asks: ${truncate(detail, 120)}` : "Agent has a question";
  if (kind === "command")
    return detail ? `Agent asks to run ${truncate(detail, 100)}` : "Agent asks to run a command";
  if (kind === "file-change")
    return detail ? `Agent asks to change ${truncate(detail, 100)}` : "Agent asks to change files";
  if (kind === "file-read")
    return detail ? `Agent asks to read ${truncate(detail, 100)}` : "Agent asks to read a file";
  if (kind === "permission")
    return detail ? `Agent asks for ${truncate(detail, 100)}` : "Agent asks for a permission";
  if (kind === "mcp-elicitation") return detail ? truncate(detail, 120) : "An app asks for access";
  if (kind === "auth_refresh") return "Provider sign-in needed";
  return "Agent is waiting on you";
};

function requestItem(
  thread: OrchestrationV2ThreadShell,
  detail: PendingRequestDetail | undefined,
): SuiteHomeItem {
  const request = thread.pendingRuntimeRequest!;
  const text = detail?.requestId === request.id ? detail.text : null;
  const approvable = APPROVAL_KINDS.has(request.kind);
  const actions: Array<SuiteHomeItemAction> = approvable
    ? [openThread(thread.id, false), { id: "approve", label: "Approve", primary: true }]
    : [openThread(thread.id, true, request.kind === "user_input" ? "Answer" : "Open thread")];
  return {
    id: codeItemId.request(thread.id, request.id),
    module: "code",
    kind: request.kind === "user_input" ? "agent-question" : "agent-approval",
    title: requestTitle(request.kind, text),
    subtitle: `Thread “${truncate(thread.title, 80)}”`,
    occurredAt: iso(request.createdAt),
    priority: 90,
    waitingOnYou: true,
    actions,
    target: threadTarget(thread.id),
    facets: { codeProjectId: thread.projectId, threadId: thread.id },
  };
}

function unseenRunItem(
  thread: OrchestrationV2ThreadShell,
  completedAt: DateTime.Utc,
  failed: boolean,
): SuiteHomeItem {
  const lastMessage =
    thread.latestVisibleMessage?.role === "assistant" ? thread.latestVisibleMessage.text : null;
  const note = failed
    ? (thread.lastError ?? null)
    : lastMessage !== null && lastMessage.trim().length > 0
      ? lastMessage
      : null;
  return {
    id: failed ? codeItemId.failed(thread.id) : codeItemId.finished(thread.id),
    module: "code",
    kind: failed ? "run-failed" : "run-finished",
    title: failed ? `Run failed: ${truncate(thread.title, 100)}` : truncate(thread.title, 120),
    subtitle: failed ? "The agent stopped with an error" : "Finished, not opened yet",
    occurredAt: iso(completedAt),
    priority: failed ? 60 : 40,
    ...(note === null ? {} : { agentNote: truncate(note, 160) }),
    actions: [openThread(thread.id, true), { id: "mark-seen", label: "Mark seen" }],
    target: threadTarget(thread.id),
    facets: { codeProjectId: thread.projectId, threadId: thread.id },
  };
}

function pullRequestItem(
  thread: OrchestrationV2ThreadShell,
  link: ThreadPullRequestLink,
): SuiteHomeItem | null {
  const snapshot = link.snapshot;
  if (snapshot === null || snapshot.state !== "open" || snapshot.isDraft) return null;
  const [kind, label, priority] =
    snapshot.reviewDecision === "changes-requested"
      ? (["pr-changes-requested", "Changes requested", 60] as const)
      : snapshot.checksState === "failing"
        ? (["pr-checks-failing", "Checks failing", 55] as const)
        : snapshot.reviewDecision === "review-required"
          ? (["pr-review-requested", "Review requested", 25] as const)
          : ([null, null, 0] as const);
  if (kind === null) return null;
  const repo = link.repository.split("/").at(-1) ?? link.repository;
  const diff =
    snapshot.additions !== undefined && snapshot.deletions !== undefined
      ? ` · +${snapshot.additions} −${snapshot.deletions}`
      : "";
  return {
    id: codeItemId.pullRequest(thread.id, link.repository, link.number),
    module: "code",
    kind,
    title: `${label}: ${repo} #${link.number} “${truncate(snapshot.title, 90)}”`,
    subtitle: `Thread “${truncate(thread.title, 60)}”${diff}`,
    occurredAt: snapshot.updatedAt ?? snapshot.syncedAt,
    priority,
    actions: [
      openThread(thread.id, true, "Review in thread"),
      { id: "open-pr", label: "Open PR", target: { route: link.url } },
    ],
    target: threadTarget(thread.id),
    facets: { codeProjectId: thread.projectId, threadId: thread.id },
  };
}

/** Visible root threads, plus child threads blocked on a request the user must answer. */
function homeVisible(thread: OrchestrationV2ThreadShell, nowMs: number) {
  if (thread.deletedAt !== null || thread.archivedAt !== null) return false;
  if (thread.lineage.relationshipToParent === "subagent" && thread.pendingRuntimeRequest === null)
    return false;
  const snoozedUntil = millis(thread.snoozedUntil);
  return snoozedUntil === null || snoozedUntil <= nowMs;
}

export function buildCodeHomeSnapshot(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly requestDetails: ReadonlyMap<string, PendingRequestDetail>;
  readonly nowMs: number;
}): CodeHomeSnapshot {
  const projectsById = new Map(input.projects.map((project) => [project.id as string, project]));
  const items: Array<SuiteHomeItem> = [];
  const mergedPullRequests: Array<MergedPullRequestFact> = [];
  const activeThreadsByCodeProject = new Map<string, number>();
  const agents = { running: 0, waiting: 0, recentlyFinished: 0 };

  for (const thread of input.threads) {
    if (!homeVisible(thread, input.nowMs)) continue;
    if (!projectsById.has(thread.projectId)) continue;
    activeThreadsByCodeProject.set(
      thread.projectId,
      (activeThreadsByCodeProject.get(thread.projectId) ?? 0) + 1,
    );

    const completedMs = millis(thread.latestRunCompletedAt);
    const visitedMs = millis(thread.lastVisitedAt);
    const active = thread.activeRunId !== null || ACTIVE_STATUSES.has(thread.status);

    if (thread.pendingRuntimeRequest !== null) {
      agents.waiting += 1;
      items.push(requestItem(thread, input.requestDetails.get(thread.id)));
    } else if (active) {
      agents.running += 1;
    } else if (completedMs !== null && thread.latestRunCompletedAt != null) {
      if (input.nowMs - completedMs <= RECENTLY_FINISHED_MS) agents.recentlyFinished += 1;
      const unseen = visitedMs === null || visitedMs < completedMs;
      if (unseen) {
        const failed = thread.status === "failed";
        if (failed || thread.status === "completed" || thread.status === "idle") {
          items.push(unseenRunItem(thread, thread.latestRunCompletedAt, failed));
        }
      }
    }

    for (const link of visibleThreadPullRequests(thread.pullRequests ?? [])) {
      const item = pullRequestItem(thread, link);
      if (item !== null) items.push(item);
      const mergedAt = link.snapshot?.state === "merged" ? link.snapshot.mergedAt : null;
      const mergedMs = mergedAt ? Date.parse(mergedAt) : Number.NaN;
      if (
        mergedAt &&
        link.snapshot &&
        !Number.isNaN(mergedMs) &&
        input.nowMs - mergedMs <= MERGED_FACT_WINDOW_MS
      ) {
        mergedPullRequests.push({
          threadId: thread.id,
          threadTitle: thread.title,
          codeProjectId: thread.projectId,
          repository: link.repository,
          number: link.number,
          title: link.snapshot.title,
          url: link.url,
          mergedAt,
        });
      }
    }
  }

  return { items, agents, activeThreadsByCodeProject, mergedPullRequests };
}
