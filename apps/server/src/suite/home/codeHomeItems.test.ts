// @effect-diagnostics globalDate:off -- Fixtures build ISO times relative to a fixed clock.
import { describe, expect, it } from "@effect/vitest";
import {
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShell as ThreadShell,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { buildCodeHomeSnapshot, codeItemId, parseCodeItemId } from "./codeHomeItems.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const decodeShell = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadShell));
const decodeProject = Schema.decodeUnknownSync(OrchestrationProjectShell);

const projects = [
  decodeProject({
    id: "proj-1",
    title: "otter-one",
    workspaceRoot: "/work/otter-one",
    defaultModelSelection: null,
    scripts: [],
    createdAt: hoursAgo(1000),
    updatedAt: hoursAgo(1000),
  }),
];

function shell(id: string, overrides: Record<string, unknown> = {}): ThreadShell {
  return decodeShell({
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: "proj-1",
    title: `Thread ${id}`,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 3,
    visibleItemCount: 3,
    createdAt: hoursAgo(10),
    updatedAt: hoursAgo(1),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  });
}

const snapshotOf = (threads: ReadonlyArray<ThreadShell>, details = new Map()) =>
  buildCodeHomeSnapshot({ threads, projects, requestDetails: details, nowMs: NOW });

describe("buildCodeHomeSnapshot", () => {
  it("round-trips namespaced thread and request ids for actions", () => {
    const threadId = "thread:mcp:scope:request:0";
    const requestId = "approval:provider:1";
    expect(parseCodeItemId(codeItemId.request(threadId, requestId))).toEqual({
      kind: "request",
      threadId,
      requestId,
    });
    expect(parseCodeItemId(codeItemId.finished(threadId))).toEqual({ kind: "finished", threadId });
    expect(parseCodeItemId(codeItemId.failed(threadId))).toEqual({ kind: "failed", threadId });
    expect(parseCodeItemId("request:%broken:req")).toBeNull();
    expect(parseCodeItemId("request:thread:")).toBeNull();
  });

  it("asks the user about a pending approval, with its command and an Approve action", () => {
    const waiting = shell("t-approve", {
      status: "waiting",
      activeRunId: "run-1",
      pendingRuntimeRequest: { id: "req-1", kind: "command", createdAt: hoursAgo(0.1) },
    });
    const snapshot = snapshotOf(
      [waiting],
      new Map([["t-approve", { requestId: "req-1", text: "pnpm db:migrate" }]]),
    );
    expect(snapshot.items).toHaveLength(1);
    const [item] = snapshot.items;
    expect(item).toMatchObject({
      module: "code",
      kind: "agent-approval",
      title: "Agent asks to run pnpm db:migrate",
      priority: 90,
      waitingOnYou: true,
      facets: { codeProjectId: "proj-1", threadId: "t-approve" },
    });
    expect(item!.actions.map((action) => action.id)).toEqual(["open", "approve"]);
    expect(parseCodeItemId(item!.id)).toEqual({
      kind: "request",
      threadId: "t-approve",
      requestId: "req-1",
    });
    expect(snapshot.agents).toEqual({ running: 0, waiting: 1, recentlyFinished: 0 });
  });

  it("offers Answer, not Approve, for an agent's question", () => {
    const snapshot = snapshotOf(
      [
        shell("t-question", {
          pendingRuntimeRequest: { id: "req-2", kind: "user_input", createdAt: hoursAgo(1) },
        }),
      ],
      new Map([["t-question", { requestId: "req-2", text: "Which calendar?" }]]),
    );
    expect(snapshot.items[0]).toMatchObject({
      kind: "agent-question",
      title: "Agent asks: Which calendar?",
    });
    expect(snapshot.items[0]!.actions.map((action) => action.label)).toEqual(["Answer"]);
  });

  it("lists finished and failed runs the user has not opened, not seen ones", () => {
    const snapshot = snapshotOf([
      shell("t-done", {
        status: "completed",
        latestRunCompletedAt: hoursAgo(2),
        lastVisitedAt: hoursAgo(5),
        latestVisibleMessage: {
          id: "m1",
          role: "assistant",
          text: "Rebased the module stack.",
          updatedAt: hoursAgo(2),
        },
      }),
      shell("t-seen", {
        status: "completed",
        latestRunCompletedAt: hoursAgo(2),
        lastVisitedAt: hoursAgo(1),
      }),
      shell("t-failed", {
        status: "failed",
        latestRunCompletedAt: hoursAgo(3),
        lastError: "Provider exited",
      }),
      shell("t-stale", { status: "completed", latestRunCompletedAt: hoursAgo(72) }),
    ]);
    expect(snapshot.items.map((item) => [item.kind, item.facets?.threadId])).toEqual([
      ["run-finished", "t-done"],
      ["run-failed", "t-failed"],
      ["run-finished", "t-stale"],
    ]);
    expect(snapshot.items[0]!.agentNote).toBe("Rebased the module stack.");
    expect(snapshot.items[1]!.agentNote).toBe("Provider exited");
    expect(snapshot.agents.recentlyFinished).toBe(3);
  });

  it("counts running threads and surfaces child approvals, skipping archived and snoozed threads", () => {
    const snapshot = snapshotOf([
      shell("t-running", { status: "running", activeRunId: "run-9" }),
      shell("t-sub", {
        lineage: {
          parentThreadId: "t-running",
          relationshipToParent: "subagent",
          rootThreadId: "t-running",
        },
        pendingRuntimeRequest: { id: "req-3", kind: "command", createdAt: hoursAgo(1) },
      }),
      shell("t-archived", {
        archivedAt: hoursAgo(1),
        pendingRuntimeRequest: { id: "req-4", kind: "command", createdAt: hoursAgo(1) },
      }),
      shell("t-snoozed", {
        snoozedUntil: hoursAgo(-5),
        status: "completed",
        latestRunCompletedAt: hoursAgo(1),
      }),
    ]);
    expect(snapshot.items.map((item) => item.facets?.threadId)).toEqual(["t-sub"]);
    expect(snapshot.agents.running).toBe(1);
    expect(snapshot.agents.waiting).toBe(1);
    expect(snapshot.activeThreadsByCodeProject.get("proj-1")).toBe(2);
  });

  it("surfaces pull requests with requested changes and remembers recent merges", () => {
    const link = (number: number, snapshot: Record<string, unknown>) => ({
      host: "github.com",
      repository: "otter/otter-mail",
      number,
      url: `https://github.com/otter/otter-mail/pull/${number}`,
      source: "created",
      linkedAt: hoursAgo(20),
      snapshot: {
        title: `PR ${number}`,
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: hoursAgo(1),
        syncedAt: hoursAgo(1),
        ...snapshot,
      },
      stack: null,
    });
    const snapshot = snapshotOf([
      shell("t-pr", {
        pullRequests: [
          link(412, {
            state: "open",
            reviewDecision: "changes-requested",
            additions: 612,
            deletions: 148,
          }),
          link(31, { state: "merged", mergedAt: hoursAgo(5) }),
          link(7, { state: "open", reviewDecision: "approved", checksState: "passing" }),
        ],
      }),
    ]);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      kind: "pr-changes-requested",
      title: "Changes requested: otter-mail #412 “PR 412”",
      subtitle: "Thread “Thread t-pr” · +612 −148",
    });
    expect(snapshot.mergedPullRequests).toMatchObject([
      { number: 31, codeProjectId: "proj-1", threadId: "t-pr" },
    ]);
  });
});
