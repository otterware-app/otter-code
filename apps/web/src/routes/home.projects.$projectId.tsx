import { createFileRoute } from "@tanstack/react-router";

import { HomeProjectPage } from "../suite/home/HomePages";

function HomeProjectRoute() {
  const { projectId } = Route.useParams();
  return <HomeProjectPage key={projectId} projectId={projectId} />;
}

export const Route = createFileRoute("/home/projects/$projectId")({
  component: HomeProjectRoute,
});
