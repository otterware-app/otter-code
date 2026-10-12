/**
 * Stand-in content for module pages until their module lands. It already
 * publishes page context, so the side chat slot can be built against it.
 */
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { SUITE_WEB_MODULES } from "./modules";
import { useSuitePageContext } from "./suitePageContext";

export function SuiteModulePlaceholder({
  moduleId,
  description,
}: {
  readonly moduleId: string;
  readonly description: string;
}) {
  const module = SUITE_WEB_MODULES.find((entry) => entry.id === moduleId);
  const label = module?.label ?? moduleId;
  useSuitePageContext({ module: moduleId, title: label, refs: [] });
  const Icon = module?.icon;

  return (
    <Empty className="flex-1">
      <EmptyHeader>
        {Icon ? (
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
        ) : null}
        <EmptyTitle>{label}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
