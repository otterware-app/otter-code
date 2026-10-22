import { LanguageServiceError, OtterWsRpcGroup, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as LinearIssueSyncReactor from "./linear/LinearIssueSyncReactor.ts";
import * as ServerSettings from "./serverSettings.ts";
import type { WorkspaceLanguageService } from "./workspace/WorkspaceLanguageService.ts";
import { languageServerStatuses } from "./workspace/languageServers.ts";

const isLanguageServiceError = Schema.is(LanguageServiceError);

/** Handlers for Otter's own WebSocket methods, merged beside `ws.ts`'s. */
export const layerOtterWsRpc = (workspaceLanguage: WorkspaceLanguageService) =>
  OtterWsRpcGroup.toLayer(
    Effect.gen(function* () {
      const linearIssues = yield* LinearIssueSyncReactor.LinearIssueSyncReactor;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      // Unreadable settings must not take code intelligence down with them.
      const codeIntelligence = serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.codeIntelligence),
        Effect.orElseSucceed(() => ({})),
      );

      return OtterWsRpcGroup.of({
        [WS_METHODS.linearIssueDetail]: (input) => linearIssues.readIssueDetail(input.reference),
        [WS_METHODS.linearSubscribeIssueChanges]: () => linearIssues.issueChanges,
        [WS_METHODS.projectsLanguage]: (input) =>
          codeIntelligence.pipe(
            Effect.flatMap((settings) =>
              Effect.tryPromise({
                try: () => workspaceLanguage.request(input, settings),
                catch: (error) =>
                  isLanguageServiceError(error)
                    ? error
                    : new LanguageServiceError({
                        message: error instanceof Error ? error.message : String(error),
                        resync: false,
                      }),
              }),
            ),
          ),
        [WS_METHODS.projectsLanguageServers]: () =>
          codeIntelligence.pipe(
            Effect.flatMap((settings) => Effect.promise(() => languageServerStatuses(settings))),
            Effect.map((servers) => ({ servers })),
          ),
      });
    }),
  );
