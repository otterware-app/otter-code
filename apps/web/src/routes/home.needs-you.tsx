import { createFileRoute } from "@tanstack/react-router";

import { HomeNeedsYouPage } from "../suite/home/HomePages";

export const Route = createFileRoute("/home/needs-you")({
  component: HomeNeedsYouPage,
});
