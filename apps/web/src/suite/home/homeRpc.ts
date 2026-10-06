/**
 * Home's queries and commands against the primary environment. The overview
 * refreshes on an interval (Mail, Calendar and Drive change outside the app)
 * and immediately when a thread's attention state changes on this client, so
 * Code rows follow the sidebar without waiting for the next poll.
 */
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { SUITE_HOME_METHODS } from "@t3tools/contracts/suite";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentThreadShells } from "../../state/threads";

/** Changes when a thread starts or stops waiting on the user, or a run finishes or is seen. */
const threadAttentionSignalAtom = Atom.make((get) => {
  let signature = "";
  for (const thread of get(environmentThreadShells.threadShellsAtom)) {
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) signature += `w${thread.id};`;
    if (thread.latestRun?.completedAt) {
      signature += `c${thread.id}:${thread.latestRun.completedAt}:${thread.lastVisitedAt ?? ""};`;
    }
  }
  return signature;
}).pipe(Atom.withLabel("suite:home:thread-attention-signal"));

export const suiteHomeOverviewQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:suite:home-overview",
  tag: SUITE_HOME_METHODS.overview,
  staleTimeMs: 5_000,
  refreshIntervalMs: 20_000,
  idleTtlMs: 60_000,
  refreshTrigger: () => threadAttentionSignalAtom,
});

export const suiteHomeCommands = {
  performAction: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:suite:home-perform-action",
    tag: SUITE_HOME_METHODS.performAction,
  }),
  saveProject: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:suite:home-save-project",
    tag: SUITE_HOME_METHODS.saveProject,
  }),
  deleteProject: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:suite:home-delete-project",
    tag: SUITE_HOME_METHODS.deleteProject,
  }),
  saveView: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:suite:home-save-view",
    tag: SUITE_HOME_METHODS.saveView,
  }),
  deleteView: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:suite:home-delete-view",
    tag: SUITE_HOME_METHODS.deleteView,
  }),
  ensureAssistantProject: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:suite:ensure-assistant-project",
    tag: SUITE_HOME_METHODS.ensureAssistantProject,
  }),
};
