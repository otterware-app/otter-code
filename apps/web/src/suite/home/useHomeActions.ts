/**
 * What Home's buttons do: open an item's target, run a contributor action on
 * the server, or start a Code thread with a prepared prompt.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type {
  SuiteHomeItemAction,
  SuiteHomeItemTarget,
  SuiteHomeRankedItem,
} from "@t3tools/contracts/suite";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { ensureLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { type SuiteThreadLaunch, useSuiteThreadLauncher } from "../assistantThreads";
import type { SuitePageContext } from "../suitePageContext";
import { suiteHomeCommands } from "./homeRpc";

const errorText = (error: unknown) =>
  error instanceof Error && error.message.trim().length > 0 ? error.message : undefined;

/** The context a Home item carries into a thread it starts. */
export function homeItemContext(item: SuiteHomeRankedItem): SuitePageContext {
  return {
    module: item.module,
    title: item.title,
    refs: [
      {
        kind: `${item.module}.home-item`,
        id: item.id,
        label: item.title,
        href: item.target.route,
      },
    ],
  };
}

export function useHomeActions(environmentId: EnvironmentId | null, onChanged: () => void) {
  const navigate = useNavigate();
  const perform = useAtomCommand(suiteHomeCommands.performAction, { reportFailure: false });
  const launch = useSuiteThreadLauncher(environmentId);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const openThread = useCallback(
    (ref: ScopedThreadRef) =>
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) }),
    [navigate],
  );

  const openTarget = useCallback(
    (target: SuiteHomeItemTarget) => {
      if (/^https?:\/\//.test(target.route)) {
        void ensureLocalApi()
          .shell.openExternal(target.route)
          .catch(() => undefined);
        return;
      }
      const params: Record<string, string> = { ...target.params };
      if (target.route.includes("$environmentId") && params.environmentId === undefined) {
        if (environmentId === null) return;
        params.environmentId = environmentId;
      }
      // Contributor routes are data, so they cannot be checked against the route tree here.
      void navigate({ to: target.route as never, params: params as never });
    },
    [environmentId, navigate],
  );

  /** Starts a thread. `open` navigates to it; otherwise a toast offers to. */
  const startThread = useCallback(
    async (input: SuiteThreadLaunch & { readonly open?: boolean; readonly key?: string }) => {
      setPendingKey(input.key ?? "start");
      try {
        const ref = await launch(input);
        onChanged();
        if (input.open) {
          openThread(ref);
        } else {
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Agent started",
              description: input.title,
              timeout: 6_000,
              actionProps: { children: "Open", onClick: () => openThread(ref) },
            }),
          );
        }
        return ref;
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start the thread",
            description: errorText(error),
          }),
        );
        return null;
      } finally {
        setPendingKey(null);
      }
    },
    [launch, onChanged, openThread],
  );

  const runAction = useCallback(
    async (item: SuiteHomeRankedItem, action: SuiteHomeItemAction) => {
      if (action.target) {
        openTarget(action.target);
        return;
      }
      if (action.startThread) {
        await startThread({
          key: `${item.module}:${item.id}:${action.id}`,
          prompt: action.startThread.prompt,
          title: item.title,
          codeProjectId: action.startThread.codeProjectId ?? null,
          context: homeItemContext(item),
        });
        return;
      }
      if (environmentId === null) return;
      setPendingKey(`${item.module}:${item.id}:${action.id}`);
      const result = await perform({
        environmentId,
        input: { module: item.module, itemId: item.id, actionId: action.id },
      });
      setPendingKey(null);
      if (result._tag === "Success") {
        onChanged();
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not ${action.label.toLowerCase()}`,
            description: errorText(squashAtomCommandFailure(result)),
          }),
        );
      }
    },
    [environmentId, onChanged, openTarget, perform, startThread],
  );

  return { openTarget, openThread, runAction, startThread, pendingKey };
}
