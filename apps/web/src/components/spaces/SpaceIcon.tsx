import { CentralIcon } from "../../lib/central-icons";
import { cn } from "../../lib/utils";

export function SpaceIcon({ icon, className }: { icon: string; className?: string }) {
  return <CentralIcon name={icon} className={cn("size-4", className)} />;
}
