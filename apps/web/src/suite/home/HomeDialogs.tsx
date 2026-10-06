/**
 * Create and edit cross-app projects (name, color, and the rules that file
 * mail, events, files and Code threads under them) and saved views.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectIconColor } from "@t3tools/contracts";
import type {
  SuiteHomeItemModule,
  SuiteProject,
  SuiteProjectRules,
  SuiteView,
  SuiteViewFilter,
  SuiteViewTimeRange,
} from "@t3tools/contracts/suite";
import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { cn } from "../../lib/utils";
import { PROJECT_ICON_COLORS } from "../../projectIconColors";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { suiteHomeCommands } from "./homeRpc";
import { HOME_MODULES } from "./homePresentation";

export const EMPTY_PROJECT_RULES: SuiteProjectRules = {
  code: { projectIds: [] },
  mail: { senders: [], domains: [], labels: [], projectIds: [] },
  calendar: { calendarIds: [], keywords: [] },
  drive: { folderIds: [], folderSlugs: [] },
};

export const EMPTY_VIEW_FILTER: SuiteViewFilter = {
  modules: [],
  projectIds: [],
  kinds: [],
  timeRange: "any",
  waitingOnMe: false,
};

const splitList = (text: string) =>
  text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
const joinList = (values: ReadonlyArray<string>) => values.join(", ");

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : undefined,
    }),
  );
}

function Field(props: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label>{props.label}</Label>
        {props.hint ? (
          <span className="text-2xs text-muted-foreground/80">{props.hint}</span>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}

function ListInput(props: {
  readonly label: string;
  readonly hint?: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field label={props.label} {...(props.hint ? { hint: props.hint } : {})}>
      <Input
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Field>
  );
}

function RuleSection(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-lg border border-border/60 p-3">
      <legend className="px-1 font-medium text-muted-foreground text-xs">{props.title}</legend>
      {props.children}
    </fieldset>
  );
}

/** Text drafts of the rule lists, so typing a comma does not reformat the field. */
type RuleText = Record<
  | "senders"
  | "domains"
  | "labels"
  | "mailProjectIds"
  | "calendarIds"
  | "keywords"
  | "folderIds"
  | "folderSlugs",
  string
>;

const rulesToText = (rules: SuiteProjectRules): RuleText => ({
  senders: joinList(rules.mail.senders),
  domains: joinList(rules.mail.domains),
  labels: joinList(rules.mail.labels),
  mailProjectIds: joinList(rules.mail.projectIds),
  calendarIds: joinList(rules.calendar.calendarIds),
  keywords: joinList(rules.calendar.keywords),
  folderIds: joinList(rules.drive.folderIds),
  folderSlugs: joinList(rules.drive.folderSlugs),
});

export interface ProjectDialogSeed {
  readonly project: SuiteProject | null;
  readonly name?: string;
  readonly codeProjectIds?: ReadonlyArray<string>;
}

export function ProjectDialog({
  environmentId,
  seed,
  onOpenChange,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  /** null closes the dialog. */
  readonly seed: ProjectDialogSeed | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: (project: SuiteProject | null) => void;
}) {
  return (
    <Dialog open={seed !== null} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:w-[36rem]">
        {seed ? (
          <ProjectForm
            key={seed.project?.id ?? "new"}
            environmentId={environmentId}
            seed={seed}
            onCancel={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ProjectForm({
  environmentId,
  seed,
  onCancel,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly seed: ProjectDialogSeed;
  readonly onCancel: () => void;
  readonly onSaved: (project: SuiteProject | null) => void;
}) {
  const save = useAtomCommand(suiteHomeCommands.saveProject, { reportFailure: false });
  const remove = useAtomCommand(suiteHomeCommands.deleteProject, { reportFailure: false });
  const codeProjects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      !(
        project.title === "Otterware Assistant" && project.workspaceRoot.endsWith("agent-workspace")
      ),
  );
  const initialRules = seed.project?.rules ?? EMPTY_PROJECT_RULES;
  const [name, setName] = useState(seed.project?.name ?? seed.name ?? "");
  const [color, setColor] = useState<ProjectIconColor>(seed.project?.color ?? "blue");
  const [codeProjectIds, setCodeProjectIds] = useState<ReadonlySet<string>>(
    new Set(seed.project?.rules.code.projectIds ?? seed.codeProjectIds ?? []),
  );
  const [text, setText] = useState<RuleText>(rulesToText(initialRules));
  const [busy, setBusy] = useState(false);
  const setField = (field: keyof RuleText) => (value: string) =>
    setText((current) => ({ ...current, [field]: value }));

  const submit = async () => {
    if (name.trim().length === 0 || busy) return;
    setBusy(true);
    const rules: SuiteProjectRules = {
      code: { projectIds: [...codeProjectIds] },
      mail: {
        senders: splitList(text.senders),
        domains: splitList(text.domains),
        labels: splitList(text.labels),
        projectIds: splitList(text.mailProjectIds),
      },
      calendar: { calendarIds: splitList(text.calendarIds), keywords: splitList(text.keywords) },
      drive: { folderIds: splitList(text.folderIds), folderSlugs: splitList(text.folderSlugs) },
    };
    const result = await save({
      environmentId,
      input: {
        ...(seed.project ? { id: seed.project.id } : {}),
        name: name.trim(),
        color,
        ...(seed.project?.icon ? { icon: seed.project.icon } : {}),
        rules,
      },
    });
    setBusy(false);
    if (result._tag === "Success") onSaved(result.value);
    else if (!isAtomCommandInterrupted(result)) {
      reportFailure("Could not save the project", squashAtomCommandFailure(result));
    }
  };

  const destroy = async () => {
    if (!seed.project || busy) return;
    setBusy(true);
    const result = await remove({ environmentId, input: { id: seed.project.id } });
    setBusy(false);
    if (result._tag === "Success") onSaved(null);
    else if (!isAtomCommandInterrupted(result)) {
      reportFailure("Could not delete the project", squashAtomCommandFailure(result));
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{seed.project ? "Edit project" : "New project"}</DialogTitle>
        <DialogDescription>
          A project gathers one customer’s or product’s mail, events, files and Code threads.
          Anything matching one of its rules shows up under it.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <Field label="Name">
                <Input
                  autoFocus
                  value={name}
                  placeholder="Acme rollout"
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            </div>
          </div>
          <Field label="Color">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Project color">
              {PROJECT_ICON_COLORS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-label={option.label}
                  aria-pressed={color === option.value}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    color === option.value && "border-foreground/64",
                  )}
                  onClick={() => setColor(option.value)}
                >
                  <span className={cn("size-4 rounded-full", option.swatchClassName)} />
                </button>
              ))}
            </div>
          </Field>
          <RuleSection title="Code">
            {codeProjects.length === 0 ? (
              <p className="text-muted-foreground text-xs">No Code projects on this environment.</p>
            ) : (
              <div className="grid max-h-40 grid-cols-2 gap-x-3 gap-y-1.5 overflow-y-auto">
                {codeProjects.map((project) => (
                  <Label key={project.id} className="min-w-0">
                    <Checkbox
                      checked={codeProjectIds.has(project.id)}
                      onCheckedChange={(checked) =>
                        setCodeProjectIds((current) => {
                          const next = new Set(current);
                          if (checked) next.add(project.id);
                          else next.delete(project.id);
                          return next;
                        })
                      }
                    />
                    <span className="truncate">{project.title}</span>
                  </Label>
                ))}
              </div>
            )}
          </RuleSection>
          <RuleSection title="Mail">
            <div className="grid gap-3 sm:grid-cols-2">
              <ListInput
                label="Domains"
                placeholder="acme.com"
                value={text.domains}
                onChange={setField("domains")}
              />
              <ListInput
                label="Senders"
                placeholder="eva@acme.com"
                value={text.senders}
                onChange={setField("senders")}
              />
              <ListInput
                label="Labels"
                placeholder="Customers/Acme"
                value={text.labels}
                onChange={setField("labels")}
              />
              <ListInput
                label="Mail projects"
                hint="ids"
                placeholder="mail project id"
                value={text.mailProjectIds}
                onChange={setField("mailProjectIds")}
              />
            </div>
          </RuleSection>
          <RuleSection title="Calendar">
            <div className="grid gap-3 sm:grid-cols-2">
              <ListInput
                label="Title keywords"
                placeholder="Acme, rollout"
                value={text.keywords}
                onChange={setField("keywords")}
              />
              <ListInput
                label="Calendars"
                hint="ids"
                placeholder="calendar id"
                value={text.calendarIds}
                onChange={setField("calendarIds")}
              />
            </div>
          </RuleSection>
          <RuleSection title="Drive">
            <div className="grid gap-3 sm:grid-cols-2">
              <ListInput
                label="Folders"
                hint="paths"
                placeholder="clients/acme"
                value={text.folderSlugs}
                onChange={setField("folderSlugs")}
              />
              <ListInput
                label="Folder ids"
                placeholder="folder id"
                value={text.folderIds}
                onChange={setField("folderIds")}
              />
            </div>
          </RuleSection>
          <p className="text-muted-foreground text-xs">Separate several entries with commas.</p>
        </div>
      </DialogPanel>
      <DialogFooter>
        {seed.project ? (
          <Button
            type="button"
            variant="destructive-outline"
            className="me-auto"
            disabled={busy}
            onClick={() => void destroy()}
          >
            Delete
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || name.trim().length === 0}>
          {seed.project ? "Save" : "Create project"}
        </Button>
      </DialogFooter>
    </form>
  );
}

const TIME_RANGES: ReadonlyArray<{ readonly value: SuiteViewTimeRange; readonly label: string }> = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

export function ViewDialog({
  environmentId,
  view,
  projects,
  onOpenChange,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  /** undefined closes the dialog; null creates a view. */
  readonly view: SuiteView | null | undefined;
  readonly projects: ReadonlyArray<SuiteProject>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: (view: SuiteView | null) => void;
}) {
  return (
    <Dialog open={view !== undefined} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:w-[32rem]">
        {view !== undefined ? (
          <ViewForm
            key={view?.id ?? "new"}
            environmentId={environmentId}
            view={view}
            projects={projects}
            onCancel={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ViewForm({
  environmentId,
  view,
  projects,
  onCancel,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly view: SuiteView | null;
  readonly projects: ReadonlyArray<SuiteProject>;
  readonly onCancel: () => void;
  readonly onSaved: (view: SuiteView | null) => void;
}) {
  const save = useAtomCommand(suiteHomeCommands.saveView, { reportFailure: false });
  const remove = useAtomCommand(suiteHomeCommands.deleteView, { reportFailure: false });
  const initial = view?.filter ?? EMPTY_VIEW_FILTER;
  const [name, setName] = useState(view?.name ?? "");
  const [modules, setModules] = useState<ReadonlyArray<SuiteHomeItemModule>>(initial.modules);
  const [projectIds, setProjectIds] = useState<ReadonlyArray<string>>(initial.projectIds);
  const [kinds, setKinds] = useState(joinList(initial.kinds));
  const [timeRange, setTimeRange] = useState<SuiteViewTimeRange>(initial.timeRange);
  const [waitingOnMe, setWaitingOnMe] = useState(initial.waitingOnMe);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (name.trim().length === 0 || busy) return;
    setBusy(true);
    const result = await save({
      environmentId,
      input: {
        ...(view ? { id: view.id } : {}),
        name: name.trim(),
        ...(view?.icon ? { icon: view.icon } : {}),
        filter: { modules, projectIds, kinds: splitList(kinds), timeRange, waitingOnMe },
      },
    });
    setBusy(false);
    if (result._tag === "Success") onSaved(result.value);
    else if (!isAtomCommandInterrupted(result)) {
      reportFailure("Could not save the view", squashAtomCommandFailure(result));
    }
  };

  const destroy = async () => {
    if (!view || busy) return;
    setBusy(true);
    const result = await remove({ environmentId, input: { id: view.id } });
    setBusy(false);
    if (result._tag === "Success") onSaved(null);
    else if (!isAtomCommandInterrupted(result)) {
      reportFailure("Could not delete the view", squashAtomCommandFailure(result));
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{view ? "Edit view" : "New view"}</DialogTitle>
        <DialogDescription>A saved filter over everything that needs you.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <Field label="Name">
            <Input
              autoFocus
              value={name}
              placeholder="Waiting on me"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Apps" hint="none selected means all">
            <ToggleGroup
              multiple
              variant="outline"
              size="sm"
              aria-label="Apps"
              value={[...modules]}
              onValueChange={(values) => setModules(values as SuiteHomeItemModule[])}
            >
              {HOME_MODULES.map((module) => {
                const Icon = module.icon;
                return (
                  <Toggle key={module.id} value={module.id}>
                    <Icon />
                    {module.label}
                  </Toggle>
                );
              })}
            </ToggleGroup>
          </Field>
          {projects.length > 0 ? (
            <Field label="Projects" hint="none selected means all">
              <ToggleGroup
                multiple
                variant="outline"
                size="sm"
                aria-label="Projects"
                className="flex-wrap"
                value={[...projectIds]}
                onValueChange={(values) => setProjectIds(values as string[])}
              >
                {projects.map((project) => (
                  <Toggle key={project.id} value={project.id}>
                    {project.name}
                  </Toggle>
                ))}
              </ToggleGroup>
            </Field>
          ) : null}
          <Field label="When">
            <ToggleGroup
              aria-label="Time range"
              value={[timeRange]}
              onValueChange={(values) =>
                setTimeRange((values[0] as SuiteViewTimeRange | undefined) ?? "any")
              }
            >
              {TIME_RANGES.map((range) => (
                <Toggle key={range.value} value={range.value}>
                  {range.label}
                </Toggle>
              ))}
            </ToggleGroup>
          </Field>
          <Field label="Kinds" hint="e.g. agent-approval, reply-needed">
            <Input
              value={kinds}
              placeholder="any kind"
              onChange={(event) => setKinds(event.target.value)}
            />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Label htmlFor="suite-view-waiting">Only what is waiting on me</Label>
              <p className="text-muted-foreground text-xs">
                Agents blocked on an approval or question, people waiting for a reply.
              </p>
            </div>
            <Switch
              id="suite-view-waiting"
              checked={waitingOnMe}
              onCheckedChange={setWaitingOnMe}
            />
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        {view ? (
          <Button
            type="button"
            variant="destructive-outline"
            className="me-auto"
            disabled={busy}
            onClick={() => void destroy()}
          >
            Delete
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || name.trim().length === 0}>
          {view ? "Save" : "Create view"}
        </Button>
      </DialogFooter>
    </form>
  );
}
