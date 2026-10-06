/**
 * Starting Code threads from Otterware surfaces: the Otterware Assistant
 * project (created on first use by the server), side chat drafts, and threads
 * Home starts with a prepared prompt. Everything goes through Otter Code's own
 * commands, so these are ordinary threads in every client.
 */
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useCallback } from "react";

import { scheduledTaskDefaultModel } from "../components/settings/scheduledTasksSettings.logic";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { newDraftId, newMessageId, newThreadId } from "../lib/utils";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, waitForProject } from "../state/entities";
import {
  EMPTY_SERVER_PROVIDERS,
  environmentServerConfigsAtom,
  serverEnvironment,
} from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { suiteHomeCommands } from "./home/homeRpc";
import { suitePageContextDecoration } from "./sideChat/suitePageContextReference";
import type { SuitePageContext } from "./suitePageContext";

const assistantProjectIds = new Map<EnvironmentId, ProjectId>();

/** Finds or creates the Otterware Assistant project; resolves once it is in this client's store. */
export function useEnsureAssistantProject() {
  const ensure = useAtomCommand(suiteHomeCommands.ensureAssistantProject, {
    reportFailure: false,
  });
  return useCallback(
    async (environmentId: EnvironmentId): Promise<EnvironmentProject> => {
      const known = assistantProjectIds.get(environmentId);
      const cached = known ? readProject(scopeProjectRef(environmentId, known)) : null;
      if (cached) return cached;
      const result = await ensure({ environmentId, input: {} });
      if (result._tag !== "Success") {
        throw isAtomCommandInterrupted(result)
          ? new Error("Cancelled.")
          : squashAtomCommandFailure(result);
      }
      const projectId = ProjectId.make(result.value.projectId);
      assistantProjectIds.set(environmentId, projectId);
      return waitForProject(scopeProjectRef(environmentId, projectId));
    },
    [ensure],
  );
}

/** The Assistant project's id once this client has resolved it, for filtering its threads. */
export function knownAssistantProjectId(environmentId: EnvironmentId | null): ProjectId | null {
  return environmentId === null ? null : (assistantProjectIds.get(environmentId) ?? null);
}

function projectDefaults(project: EnvironmentProject) {
  const settings =
    appAtomRegistry.get(environmentServerConfigsAtom).get(project.environmentId)?.settings ??
    DEFAULT_SERVER_SETTINGS;
  return resolveProjectSettings(settings, project.id, project).settings;
}

/**
 * A fresh draft in `project` for a side chat. Each module keeps its own draft
 * slot (`logicalKey`), so side chats never take over the project's own
 * new-thread draft or each other's.
 */
export function createSideChatDraft(
  project: EnvironmentProject,
  logicalKey: string,
): { readonly draftId: DraftId; readonly threadId: ReturnType<typeof newThreadId> } {
  const draftId = newDraftId();
  const threadId = newThreadId();
  const { setLogicalProjectDraftThreadId, applyStickyState } = useComposerDraftStore.getState();
  setLogicalProjectDraftThreadId(
    logicalKey,
    scopeProjectRef(project.environmentId, project.id),
    draftId,
    {
      threadId,
      createdAt: new Date().toISOString(),
      branch: null,
      worktreePath: null,
      envMode: "local",
      startFromOrigin: false,
      runtimeMode: projectDefaults(project).defaultRuntimeMode,
      interactionMode: "default",
    },
  );
  applyStickyState(draftId);
  return { draftId, threadId };
}

export interface SuiteThreadLaunch {
  readonly prompt: string;
  /** Shown until the server generates a title from the first message. */
  readonly title: string;
  /** A Code project; omitted starts in the Otterware Assistant project. */
  readonly codeProjectId?: string | null | undefined;
  /** Sent as a `suite-page` context record with the message. */
  readonly context?: SuitePageContext | null | undefined;
  /** Defaults to the project's, then the environment's default model. */
  readonly modelSelection?: ModelSelection | null | undefined;
}

/**
 * Starts a thread with its first message in one command, the way the
 * composer's first send does, and resolves to the new thread.
 */
export function useSuiteThreadLauncher(environmentId: EnvironmentId | null) {
  const ensureAssistant = useEnsureAssistantProject();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  return useCallback(
    async (launch: SuiteThreadLaunch): Promise<ScopedThreadRef> => {
      if (environmentId === null) throw new Error("No environment is connected.");
      const project =
        launch.codeProjectId != null
          ? readProject(scopeProjectRef(environmentId, ProjectId.make(launch.codeProjectId)))
          : await ensureAssistant(environmentId);
      if (project === null) throw new Error("That project is not available on this environment.");
      const serverConfig = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
      const settings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
      const providers =
        appAtomRegistry.get(serverEnvironment.providersValueAtom(environmentId)) ??
        EMPTY_SERVER_PROVIDERS;
      const entries = sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      );
      const modelSelection =
        launch.modelSelection ?? scheduledTaskDefaultModel(settings, project, entries);
      if (modelSelection === null) {
        throw new Error("No provider is ready. Set one up in Settings, then try again.");
      }
      const defaults = projectDefaults(project);
      const supportsContext = serverConfig?.environment.capabilities.inlineMessageContext === true;
      const decoration =
        launch.context && supportsContext ? suitePageContextDecoration(launch.context) : null;
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: `${decoration?.prefix ?? ""}${launch.prompt}`,
            attachments: [],
            ...(decoration ? { context: { version: 1, records: decoration.records } } : {}),
          },
          modelSelection,
          titleSeed: launch.title,
          runtimeMode: defaults.defaultRuntimeMode,
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: project.id,
              title: launch.title,
              modelSelection,
              runtimeMode: defaults.defaultRuntimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        },
      });
      if (result._tag !== "Success") {
        throw isAtomCommandInterrupted(result)
          ? new Error("Cancelled.")
          : squashAtomCommandFailure(result);
      }
      return scopeThreadRef(environmentId, threadId);
    },
    [ensureAssistant, environmentId, startTurn],
  );
}
