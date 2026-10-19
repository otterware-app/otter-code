import { useId, type RefObject } from "react";

import { MoreHorizontalIcon } from "../../lib/icons";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type RailMenuEntry = { key: string; label: string };

export function RailMoreMenu({
  spaces,
  projects,
  pinnedKeys,
  hiddenItems,
  onToggleShortcut,
  onCustomize,
  triggerRef,
  buttonClassName,
  tooltipDisabled = false,
}: {
  spaces: ReadonlyArray<RailMenuEntry>;
  projects: ReadonlyArray<RailMenuEntry>;
  pinnedKeys: ReadonlySet<string>;
  hiddenItems: ReadonlyArray<{ id: string; label: string; onSelect: () => void }>;
  onToggleShortcut: (key: string) => void;
  onCustomize: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  buttonClassName: string;
  tooltipDisabled?: boolean;
}) {
  const id = useId();
  return (
    <Menu>
      <Tooltip disabled={tooltipDisabled}>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  ref={triggerRef}
                  type="button"
                  aria-label="More"
                  className={buttonClassName}
                />
              }
            />
          }
        >
          <MoreHorizontalIcon className="size-5" />
        </TooltipTrigger>
        <TooltipPopup side="right">More</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="right" className="max-h-96 w-64 min-w-64 overflow-y-auto">
        {hiddenItems.length > 0 ? (
          <>
            <MenuGroup>
              {hiddenItems.map((item) => (
                <MenuItem key={item.id} onClick={item.onSelect}>
                  <span className="text-ui">{item.label}</span>
                </MenuItem>
              ))}
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup aria-labelledby={`${id}-spaces`}>
          <div id={`${id}-spaces`} className="px-2 py-1.5 text-ui text-muted-foreground">
            Spaces in the rail
          </div>
          {spaces.map((entry) => (
            <MenuCheckboxItem
              key={entry.key}
              checked={pinnedKeys.has(entry.key)}
              onCheckedChange={() => onToggleShortcut(entry.key)}
            >
              <span className="block min-w-0 truncate text-ui">{entry.label}</span>
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup aria-labelledby={`${id}-projects`}>
          <div id={`${id}-projects`} className="px-2 py-1.5 text-ui text-muted-foreground">
            Projects in the rail
          </div>
          {projects.length === 0 ? (
            <div className="px-2 py-1 text-ui text-muted-foreground">No projects yet</div>
          ) : (
            projects.map((entry) => (
              <MenuCheckboxItem
                key={entry.key}
                checked={pinnedKeys.has(entry.key)}
                onCheckedChange={() => onToggleShortcut(entry.key)}
              >
                <span className="block min-w-0 truncate text-ui">{entry.label}</span>
              </MenuCheckboxItem>
            ))
          )}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuItem onClick={onCustomize}>
            <span className="text-ui">Customize…</span>
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
