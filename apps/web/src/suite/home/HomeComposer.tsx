/**
 * "Ask Otter or start something": starts a normal Code thread with the typed
 * prompt and the chosen scope as context. Scope chips pick the cross-app
 * project, which apps the agent should look at, the Code project (the
 * Otterware Assistant project by default) and the model. It wears the chat
 * composer's surface and controls.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import type { SuiteHomeItemModule, SuiteProject } from "@t3tools/contracts/suite";
import { ArrowUpIcon, CheckIcon, FolderCodeIcon, LayersIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { ComposerControl, ComposerControlChevron } from "../../components/chat/ComposerControl";
import { ComposerSurface } from "../../components/chat/ComposerSurface";
import { ProviderModelPicker } from "../../components/chat/ProviderModelPicker";
import { scheduledTaskDefaultModel } from "../../components/settings/scheduledTasksSettings.logic";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { Spinner } from "../../components/ui/spinner";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import type { SuitePageRef } from "../suitePageContext";
import { HOME_MODULES, SuiteProjectMonogram } from "./homePresentation";
import type { useHomeActions } from "./useHomeActions";

const SCOPE_MODULES = HOME_MODULES.filter((module) => module.id !== "code");

export function HomeComposer({
  environmentId,
  projects,
  initialProjectId = null,
  actions,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<SuiteProject>;
  readonly initialProjectId?: string | null;
  readonly actions: ReturnType<typeof useHomeActions>;
}) {
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [modules, setModules] = useState<ReadonlySet<SuiteHomeItemModule>>(new Set());
  // undefined follows the cross-app project; null explicitly selects the Assistant.
  const [codeProjectId, setCodeProjectId] = useState<string | null | undefined>(undefined);
  const [model, setModel] = useState<ModelSelection | null>(null);

  const codeProjects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      !(
        project.title === "Otterware Assistant" && project.workspaceRoot.endsWith("agent-workspace")
      ),
  );
  const project = projects.find((entry) => entry.id === projectId) ?? null;
  // A cross-app project with exactly one Code project starts there unless the user picked one.
  const impliedCodeProjectId =
    project !== null && project.rules.code.projectIds.length === 1
      ? project.rules.code.projectIds[0]!
      : null;
  const effectiveCodeProjectId = codeProjectId === undefined ? impliedCodeProjectId : codeProjectId;
  const codeProject = codeProjects.find((entry) => entry.id === effectiveCodeProjectId) ?? null;

  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const selection = model ?? scheduledTaskDefaultModel(settings, codeProject, instanceEntries);
  const selectedInstanceId = selection?.instanceId ?? null;
  const selectedModel = selection?.model ?? null;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    selectedInstanceId,
    selectedModel,
  );

  const sending = actions.pendingKey === "home-composer";
  const canSend = prompt.trim().length > 0 && !sending;

  const submit = async () => {
    const text = prompt.trim();
    if (!canSend) return;
    const refs: SuitePageRef[] = [
      ...(project ? [{ kind: "suite.project", id: project.id, label: project.name }] : []),
      ...[...modules].map((module) => ({
        kind: "suite.app",
        id: module,
        label: HOME_MODULES.find((entry) => entry.id === module)?.label ?? module,
      })),
    ];
    const ref = await actions.startThread({
      key: "home-composer",
      prompt: text,
      title: text.split("\n")[0]!.slice(0, 80),
      codeProjectId: effectiveCodeProjectId,
      modelSelection: selection,
      context:
        refs.length > 0 ? { module: "home", title: project ? project.name : "Home", refs } : null,
      open: true,
    });
    if (ref) setPrompt("");
  };

  return (
    <ComposerSurface.Shell>
      <ComposerSurface.Host>
        <ComposerSurface.Main>
          <form
            className="flex flex-col gap-1 px-3 pt-2.5 pb-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <textarea
              aria-label="Ask Otter or start something"
              className="field-sizing-content max-h-48 min-h-11 w-full resize-none bg-transparent px-1 py-1 text-base outline-none placeholder:text-muted-foreground/70 sm:text-sm"
              placeholder="Ask Otter or start something: “reply to Christophe, then open a thread to add CORS for the desktop origin”"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <Menu>
                <MenuTrigger render={<ComposerControl size="xs" aria-label="Cross-app project" />}>
                  {project ? (
                    <SuiteProjectMonogram project={project} className="size-3.5" />
                  ) : (
                    <LayersIcon />
                  )}
                  {project ? project.name : "Project"}
                  <ComposerControlChevron size="xs" />
                </MenuTrigger>
                <MenuPopup align="start">
                  <MenuItem onClick={() => setProjectId(null)}>No project</MenuItem>
                  {projects.length > 0 ? <MenuSeparator /> : null}
                  {projects.map((entry) => (
                    <MenuItem key={entry.id} onClick={() => setProjectId(entry.id)}>
                      <SuiteProjectMonogram project={entry} />
                      {entry.name}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
              {SCOPE_MODULES.map((module) => {
                const Icon = module.icon;
                const pressed = modules.has(module.id);
                return (
                  <ComposerControl
                    key={module.id}
                    size="xs"
                    aria-pressed={pressed}
                    onClick={() =>
                      setModules((current) => {
                        const next = new Set(current);
                        if (pressed) next.delete(module.id);
                        else next.add(module.id);
                        return next;
                      })
                    }
                  >
                    <Icon />
                    {module.label}
                    {pressed ? <CheckIcon /> : null}
                  </ComposerControl>
                );
              })}
              <Menu>
                <MenuTrigger render={<ComposerControl size="xs" aria-label="Code project" />}>
                  <FolderCodeIcon />
                  <span className="max-w-40 truncate">
                    {codeProject ? codeProject.title : "Otterware Assistant"}
                  </span>
                  <ComposerControlChevron size="xs" />
                </MenuTrigger>
                <MenuPopup align="start" className="max-h-80">
                  <MenuItem onClick={() => setCodeProjectId(null)}>Otterware Assistant</MenuItem>
                  {codeProjects.length > 0 ? <MenuSeparator /> : null}
                  {codeProjects.map((entry) => (
                    <MenuItem key={entry.id} onClick={() => setCodeProjectId(entry.id)}>
                      {entry.title}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
              {selection ? (
                <ProviderModelPicker
                  size="xs"
                  compact
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  isComposerOwned={false}
                  onInstanceModelChange={(instanceId: ProviderInstanceId, nextModel: string) =>
                    setModel({ instanceId, model: nextModel })
                  }
                />
              ) : null}
              <span className="flex-1" />
              <Button
                type="submit"
                size="icon-sm"
                aria-label="Start"
                disabled={!canSend || selection === null}
              >
                {sending ? <Spinner /> : <ArrowUpIcon />}
              </Button>
            </div>
          </form>
        </ComposerSurface.Main>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>
  );
}
