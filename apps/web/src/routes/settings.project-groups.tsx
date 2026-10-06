import { createFileRoute } from "@tanstack/react-router";
import { ProjectGroupsSettings } from "../components/settings/ProjectGroupsSettings";

export const Route = createFileRoute("/settings/project-groups")({
  component: ProjectGroupsSettings,
});
