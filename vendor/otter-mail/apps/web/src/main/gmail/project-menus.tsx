/**
 * Putting conversations in projects: the "Add to project" menu items (the
 * list's right-click menu, the reader's menu) and the New project dialog,
 * mounted once by HomeView and opened from anywhere.
 */

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, FolderIcon, FolderPlusIcon } from "lucide-react";

import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { useAccounts } from "./hooks";
import { projectsApi, useProjects, type Project } from "./projects";
import { toast } from "./toast";

export type ThreadRef = { accountId: string; threadId: string };

type NewProjectRequest = {
  threads: ThreadRef[];
  /** Open the project once it's made (the sidebar's +). */
  open: boolean;
  /** The name to start from (a conversation's subject). */
  name: string;
};

const listeners = new Set<(request: NewProjectRequest) => void>();

/** Opens the New project dialog; the project starts with `threads`. */
export function requestNewProject(request: Partial<NewProjectRequest> = {}): void {
  const full = { threads: [], open: false, name: "", ...request };
  for (const listener of listeners) listener(full);
}

export function NewProjectDialog({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const [request, setRequest] = useState<NewProjectRequest | null>(null);
  const [name, setName] = useState("");
  const qc = useQueryClient();
  useEffect(() => {
    const listener = (next: NewProjectRequest) => {
      setRequest(next);
      setName(next.name);
    };
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);

  const create = async () => {
    if (!request || !name.trim()) return;
    const project = await projectsApi.create(name.trim(), request.threads);
    console.log("[NewProjectDialog:create]", { threads: request.threads.length });
    // Opened before the list has it, the page would find no such project.
    await qc.refetchQueries({ queryKey: ["projects"] });
    if (request.open) onOpenProject(project.id);
    else
      toast.success(`Added to “${project.name}”`, {
        action: { label: "Open", onClick: () => onOpenProject(project.id) },
      });
  };

  return (
    <Dialog
      open={request != null}
      onOpenChange={(open) => {
        if (!open) setRequest(null);
      }}
      title="New project"
      description="Keep a piece of work's conversations, documents, links and notes together until it's settled."
      confirmLabel="Create"
      confirmDisabled={!name.trim()}
      onConfirm={create}
    >
      <Field label="Name" orientation="vertical">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Acme services agreement"
          autoFocus
        />
      </Field>
    </Dialog>
  );
}

/** Whether a project has every one of these conversations. */
function hasAll(project: Project, threads: ThreadRef[], emailOf: (id: string) => string) {
  return threads.every((t) =>
    project.threads.some((p) => p.threadId === t.threadId && p.email === emailOf(t.accountId)),
  );
}

type ItemProps = { icon?: ReactNode; onSelect?: () => void; children: ReactNode };

/**
 * Active projects to add the conversations to (a check where they're in
 * already: choosing it takes them out), then New project….
 */
export function AddToProjectItems({
  threads,
  suggestedName = "",
  Item,
  Separator,
}: {
  threads: ThreadRef[];
  /** For a new project: the conversation's subject. */
  suggestedName?: string;
  Item: ComponentType<ItemProps>;
  Separator: ComponentType;
}) {
  const projects = (useProjects().data ?? []).filter((p) => p.status === "active");
  const accounts = useAccounts().data ?? [];
  const emailOf = (id: string) => accounts.find((a) => a.id === id)?.email.toLowerCase() ?? "";

  const toggle = async (project: Project, inIt: boolean) => {
    try {
      if (inIt) {
        for (const t of threads)
          await projectsApi.removeThread(project.id, emailOf(t.accountId), t.threadId);
        toast.success(`Removed from “${project.name}”`);
      } else {
        await projectsApi.addThreads(project.id, threads);
        toast.success(`Added to “${project.name}”`);
      }
    } catch (err) {
      toast.error("Couldn't change the project", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <>
      {projects.map((project) => {
        const inIt = hasAll(project, threads, emailOf);
        return (
          <Item
            key={project.id}
            icon={inIt ? <CheckIcon /> : <FolderIcon />}
            onSelect={() => void toggle(project, inIt)}
          >
            {project.name}
          </Item>
        );
      })}
      {projects.length > 0 ? <Separator /> : null}
      <Item
        icon={<FolderPlusIcon />}
        onSelect={() => requestNewProject({ threads, name: suggestedName })}
      >
        New project…
      </Item>
    </>
  );
}
