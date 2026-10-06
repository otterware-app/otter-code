/**
 * Otter Code's side of Home, read from the orchestration projections: threads
 * waiting on an approval or a question, finished runs the user has not opened,
 * pull requests that need attention, and the agents summary. Only unsettled
 * threads are read, and the result is cached briefly because every open Home
 * polls it.
 */
import { CommandId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { SuiteHomeActionError } from "@t3tools/contracts/suite";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import type { SuiteHomeContributor } from "../SuiteModule.ts";
import {
  buildCodeHomeSnapshot,
  type CodeHomeSnapshot,
  parseCodeItemId,
  type PendingRequestDetail,
} from "./codeHomeItems.ts";

/** At most this many waiting threads get their request text read per refresh. */
const MAX_REQUEST_DETAILS = 12;
const CACHE_TTL = "3 seconds";

const EMPTY_SNAPSHOT: CodeHomeSnapshot = {
  items: [],
  agents: { running: 0, waiting: 0, recentlyFinished: 0 },
  activeThreadsByCodeProject: new Map(),
  mergedPullRequests: [],
};

export class CodeHomeActivity extends Context.Service<
  CodeHomeActivity,
  {
    /** The latest snapshot; `ok` is false when the projections could not be read. */
    readonly snapshot: Effect.Effect<CodeHomeSnapshot & { readonly ok: boolean }>;
    readonly contributor: SuiteHomeContributor;
  }
>()("t3/suite/home/CodeHomeActivity") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;

  const readRequestDetail = (threadId: ThreadId, requestId: string) =>
    orchestrator
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["approval_request", "user_input_request"],
      })
      .pipe(
        Effect.map((records): PendingRequestDetail => {
          const item = records.turnItems.findLast(
            (candidate) =>
              (candidate.type === "approval_request" || candidate.type === "user_input_request") &&
              candidate.requestId === requestId,
          );
          if (item?.type === "approval_request") {
            return { requestId, text: item.prompt ?? item.appName ?? null };
          }
          if (item?.type === "user_input_request") {
            return { requestId, text: item.questions[0]?.question ?? null };
          }
          return { requestId, text: null };
        }),
        Effect.orElseSucceed((): PendingRequestDetail => ({ requestId, text: null })),
      );

  const build = Effect.gen(function* () {
    const shell = yield* orchestrator.getShellSnapshot({
      location: "active",
      unsettledOnly: true,
    });
    const projects = yield* projectStore.listShells();
    const waiting = shell.threads
      .filter((thread) => thread.pendingRuntimeRequest !== null && thread.deletedAt === null)
      .slice(0, MAX_REQUEST_DETAILS);
    const details = yield* Effect.forEach(
      waiting,
      (thread) =>
        readRequestDetail(thread.id, thread.pendingRuntimeRequest!.id).pipe(
          Effect.map((detail) => [thread.id as string, detail] as const),
        ),
      { concurrency: 4 },
    );
    const now = yield* DateTime.now;
    return {
      ...buildCodeHomeSnapshot({
        threads: shell.threads,
        projects,
        requestDetails: new Map(details),
        nowMs: DateTime.toEpochMillis(now),
      }),
      ok: true,
    };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Home could not read Code activity", { cause }).pipe(
        Effect.as({ ...EMPTY_SNAPSHOT, ok: false }),
      ),
    ),
    Effect.withSpan("CodeHomeActivity.build"),
  );
  const snapshot = yield* Effect.cachedWithTTL(build, CACHE_TTL);

  const newCommandId = crypto.randomUUIDv4.pipe(
    Effect.orDie,
    Effect.map((id) => CommandId.make(`otterware-home:${id}`)),
  );

  const performAction: NonNullable<SuiteHomeContributor["performAction"]> = (itemId, actionId) =>
    Effect.gen(function* () {
      const parsed = parseCodeItemId(itemId);
      const fail = (cause?: unknown) =>
        new SuiteHomeActionError({
          module: "code",
          itemId,
          actionId,
          ...(cause === undefined ? {} : { cause }),
        });
      if (parsed === null) return yield* fail();
      const threadId = ThreadId.make(parsed.threadId);
      if (actionId === "approve" && parsed.kind === "request") {
        yield* threads
          .dispatch({
            type: "runtime-request.respond",
            commandId: yield* newCommandId,
            threadId,
            requestId: RuntimeRequestId.make(parsed.requestId),
            decision: "accept",
          })
          .pipe(Effect.mapError(fail));
        return;
      }
      if (actionId === "mark-seen") {
        const shell = yield* orchestrator.getThreadShell(threadId).pipe(Effect.mapError(fail));
        if (shell === null) return yield* fail();
        yield* threads
          .dispatch({
            type: "thread.visit",
            commandId: yield* newCommandId,
            threadId,
            visitedAt: DateTime.formatIso(shell.updatedAt),
          })
          .pipe(Effect.mapError(fail));
        return;
      }
      return yield* fail();
    });

  const contributor: SuiteHomeContributor = {
    module: "code",
    // Home reports the module as not ok when the projections could not be read.
    needsYou: Effect.flatMap(snapshot, (current) =>
      current.ok ? Effect.succeed(current.items) : Effect.die("Code activity is unavailable"),
    ),
    performAction,
  };

  return CodeHomeActivity.of({ snapshot, contributor });
});

export const layer = Layer.effect(CodeHomeActivity, make);
