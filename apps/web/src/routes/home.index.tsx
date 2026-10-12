import { createFileRoute } from "@tanstack/react-router";

import { HomeDashboardPage } from "../suite/home/HomePages";

export const Route = createFileRoute("/home/")({
  component: HomeDashboardPage,
});
