import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

export function contextCompactionLabel(
  status: Extract<OrchestrationV2TurnItem, { type: "compaction" }>["status"],
) {
  switch (status) {
    case "failed":
      return "Context compaction failed";
    case "cancelled":
    case "interrupted":
      return "Context compaction stopped";
    case "pending":
    case "running":
    case "waiting":
      return "Compacting context";
    default:
      return "Context compacted";
  }
}
