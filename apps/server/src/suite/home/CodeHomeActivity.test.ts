import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as CodeHomeActivity from "./CodeHomeActivity.ts";
import { codeItemId } from "./codeHomeItems.ts";

it.effect("Code actions use existing commands and invalidate the overview cache", () => {
  let reads = 0;
  const commands: Array<unknown> = [];
  const updatedAt = DateTime.makeUnsafe("2026-10-06T12:00:00Z");
  const layer = CodeHomeActivity.layer.pipe(
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getShellSnapshot: () =>
          Effect.sync(() => {
            reads += 1;
            return { threads: [], archivedThreads: [] } as never;
          }),
        getThreadShell: () => Effect.succeed({ updatedAt } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return {} as never;
          }),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const activity = yield* CodeHomeActivity.CodeHomeActivity;
    yield* activity.snapshot;
    yield* activity.snapshot;
    assert.strictEqual(reads, 1);
    yield* activity.contributor.performAction!(
      codeItemId.request("thread:mcp:1", "request:1"),
      "approve",
    );
    yield* activity.snapshot;
    assert.strictEqual(reads, 2);
    yield* activity.contributor.performAction!(codeItemId.finished("thread:mcp:1"), "mark-seen");
    const [approval, visit] = commands as Array<Record<string, unknown>>;
    assert.strictEqual(approval?.type, "runtime-request.respond");
    assert.strictEqual(approval?.threadId, "thread:mcp:1");
    assert.strictEqual(approval?.requestId, "request:1");
    assert.strictEqual(approval?.decision, "accept");
    assert.strictEqual(visit?.type, "thread.visit");
    assert.strictEqual(visit?.threadId, "thread:mcp:1");
    assert.strictEqual(visit?.visitedAt, DateTime.formatIso(updatedAt));
    const rejected = yield* activity.contributor.performAction!(
      "finished:thread-1",
      "approve",
    ).pipe(Effect.flip);
    assert.strictEqual(rejected._tag, "SuiteHomeActionError");
    assert.strictEqual(commands.length, 2);
  }).pipe(Effect.provide(layer));
});
