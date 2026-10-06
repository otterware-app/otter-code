import { createFileRoute } from "@tanstack/react-router";

import { HomeAgentsPage } from "../suite/home/HomePages";

export const Route = createFileRoute("/home/agents")({
  component: HomeAgentsPage,
});
