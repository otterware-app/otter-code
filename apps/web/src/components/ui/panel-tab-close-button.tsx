import type { ReactNode } from "react";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

interface PanelTabCloseButtonProps {
  children?: ReactNode;
  label: string;
  onClick: () => void;
  tooltip?: string;
  placement?: "icon" | "trailing";
  active?: boolean;
}

export function PanelTabCloseButton({
  children,
  label,
  onClick,
  tooltip,
  placement = "icon",
  active = false,
}: PanelTabCloseButtonProps) {
  const button = (
    <button
      type="button"
      className={cn(
        "cursor-pointer group/close flex shrink-0 items-center justify-center text-muted-foreground outline-none transition-[opacity,background-color,color] hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/60",
        placement === "trailing"
          ? cn(
              "absolute top-1/2 right-1 size-6 -translate-y-1/2 rounded-sm hover:bg-foreground/8",
              active
                ? "opacity-100"
                : "opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100 pointer-coarse:pointer-events-none",
            )
          : "relative size-4 rounded-full group-hover/tab:bg-secondary group-focus-within/tab:bg-secondary hover:bg-muted",
      )}
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {placement === "icon" ? (
        <span className="relative flex size-3.5 items-center justify-center group-hover/tab:hidden group-focus-within/tab:hidden">
          {children}
        </span>
      ) : null}
      <CentralIcon
        name="cross-small"
        className={cn(
          "size-4",
          placement === "icon" && "hidden group-hover/tab:block group-focus-within/tab:block",
        )}
      />
    </button>
  );

  if (!tooltip) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
