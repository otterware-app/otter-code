import { createFileRoute } from "@tanstack/react-router";

import { HomeViewPage } from "../suite/home/HomePages";

function HomeViewRoute() {
  const { viewId } = Route.useParams();
  return <HomeViewPage key={viewId} viewId={viewId} />;
}

export const Route = createFileRoute("/home/views/$viewId")({
  component: HomeViewRoute,
});
