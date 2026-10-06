/**
 * "Otterware Assistant": the Code project that side chats and Home-started
 * threads live in, so they do not clutter the user's code projects. It is an
 * ordinary project over a plain folder, created on first use.
 *
 * The folder is `~/.otterware/agent-workspace` for a server on the user's own
 * data home, and `<baseDir>/otterware/agent-workspace` for dev servers and any
 * other explicit home, so a dev server never touches the real one.
 */
import { CommandId, ProjectId } from "@t3tools/contracts";
import { SuiteAssistantProjectError, type SuiteAssistantProject } from "@t3tools/contracts/suite";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import * as ServerConfig from "../../config.ts";
import * as ProjectService from "../../project/ProjectService.ts";

export const ASSISTANT_PROJECT_TITLE = "Otterware Assistant";

export function assistantWorkspaceRoot(input: {
  readonly baseDir: string;
  readonly devServer: boolean;
  readonly homeDir: string;
  readonly join: (...segments: Array<string>) => string;
  readonly dirname: (path: string) => string;
}): string {
  const sharedHome = !input.devServer && input.dirname(input.baseDir) === input.homeDir;
  return sharedHome
    ? input.join(input.homeDir, ".otterware", "agent-workspace")
    : input.join(input.baseDir, "otterware", "agent-workspace");
}

export class SuiteAssistantProjectService extends Context.Service<
  SuiteAssistantProjectService,
  {
    /** Finds or creates the project and (re)creates its folder. */
    readonly ensure: Effect.Effect<SuiteAssistantProject, SuiteAssistantProjectError>;
  }
>()("t3/suite/home/SuiteAssistantProject/SuiteAssistantProjectService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;

  const workspaceRoot = assistantWorkspaceRoot({
    baseDir: path.resolve(config.baseDir),
    devServer: config.devUrl !== undefined,
    homeDir: NodeOS.homedir(),
    join: path.join,
    dirname: path.dirname,
  });
  const fail = (cause: unknown) => new SuiteAssistantProjectError({ workspaceRoot, cause });

  const ensure = Effect.gen(function* () {
    // Re-made on every call, so a deleted folder still runs threads.
    yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true }).pipe(Effect.mapError(fail));
    const existing = yield* projects.getByWorkspaceRoot(workspaceRoot).pipe(Effect.mapError(fail));
    if (Option.isSome(existing)) {
      return { projectId: existing.value.id, workspaceRoot };
    }
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(fail));
    // bootstrap looks the root up before taking the workspace lock, so a
    // racing create loses with a conflict that names the winner.
    const bootstrapped = yield* projects
      .bootstrap({
        commandId: CommandId.make(`otterware-assistant-project:${id}`),
        projectId: ProjectId.make(id),
        title: ASSISTANT_PROJECT_TITLE,
        workspaceRoot,
      })
      .pipe(
        Effect.catchTags({
          ProjectConflictError: (conflict) =>
            Effect.succeed({ project: { id: conflict.conflictingProjectId }, created: false }),
        }),
        Effect.mapError(fail),
      );
    if (bootstrapped.created) {
      // Set once at create, so the user's own icon choice is never overwritten.
      yield* projects
        .update({
          commandId: CommandId.make(`otterware-assistant-project-icon:${id}`),
          projectId: bootstrapped.project.id,
          projectIcon: { kind: "lucide", name: "sparkles", color: "violet" },
        })
        .pipe(Effect.ignore);
    }
    return { projectId: bootstrapped.project.id, workspaceRoot };
  }).pipe(Effect.withSpan("SuiteAssistantProject.ensure"));

  return SuiteAssistantProjectService.of({ ensure });
});

export const layer = Layer.effect(SuiteAssistantProjectService, make);
