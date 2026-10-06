/** The rail's module buttons, from `./modules.ts`. Rendered by `SpaceRail`. */
import { useLocation, useNavigate } from "@tanstack/react-router";

import { RailButton } from "../components/sidebar/SpaceRail";
import { useSidebar } from "../components/ui/sidebar";
import { suiteModuleForPath, suiteRailModules, type SuiteWebModule } from "./modules";

export function SuiteRailButtons({ rail }: { readonly rail: SuiteWebModule["rail"] }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const activeModuleId = useLocation({
    select: (location) => suiteModuleForPath(location.pathname)?.id ?? null,
  });

  return suiteRailModules(rail).map((module) => {
    const Icon = module.icon;
    return (
      <RailButton
        key={module.id}
        label={module.label}
        selected={activeModuleId === module.id}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
          void navigate({ to: module.path });
        }}
      >
        <Icon className="size-4.5" />
      </RailButton>
    );
  });
}
