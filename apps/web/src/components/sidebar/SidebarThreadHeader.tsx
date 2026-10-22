import { SearchIcon, NewThreadIcon as SquarePenIcon, XIcon } from "~/lib/icons";
import {
  useEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";

import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  /** Receives the click so Shift+click can skip the project picker. */
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  showNewThreadInProjectHint: boolean;
  searchOpen: boolean;
  onCloseSearch: () => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
  searchOpen,
  onCloseSearch,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  // oxlint-disable-next-line t3code/react-effect-budget -- Focuses the search field when it opens.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen, searchInputRef]);

  const resultsVisible = isSearching && searchResultCount > 0;
  // Shrinking results can remove the active option; never leave aria-activedescendant pointing at it.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? `New thread (${newThreadShortcutLabel})`
    : "New thread";

  return (
    <>
      <div className="z-[1] px-(--sidebar-content-inset) pt-1 pb-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <Tooltip>
              <TooltipTrigger
                render={<SidebarMenuButton disabled={newThreadDisabled} onClick={onNewThread} />}
              >
                <SquarePenIcon />
                <span className="flex-1 truncate">New thread</span>
                {newThreadShortcutLabel ? <Kbd>{newThreadShortcutLabel}</Kbd> : null}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {showNewThreadInProjectHint ? (
                  <span className="flex flex-col gap-0.5">
                    <span>{newThreadLabel}</span>
                    <span className="text-muted-foreground">
                      New thread in current project: Shift+click
                      {newThreadInProjectShortcutLabel
                        ? ` (${newThreadInProjectShortcutLabel})`
                        : ""}
                    </span>
                  </span>
                ) : (
                  newThreadLabel
                )}
              </TooltipPopup>
            </Tooltip>
          </SidebarMenuItem>
        </SidebarMenu>
      </div>
      {searchOpen || isSearching ? (
        <div className="px-(--sidebar-content-inset) pb-3">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
            <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
            <SidebarInput
              ref={searchInputRef}
              nativeInput
              type="search"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !isSearching && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.stopPropagation();
                  onCloseSearch();
                  return;
                }
                onSearchKeyDown(event);
              }}
              placeholder="Search"
              aria-label="Search threads"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={resultsVisible}
              aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
              aria-activedescendant={
                activeResultExists
                  ? `sidebar-thread-search-result-${activeSearchResultIndex}`
                  : undefined
              }
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              className="shrink-0"
              aria-label={isSearching ? "Clear thread search" : "Close thread search"}
              onClick={() => {
                if (!isSearching) {
                  onCloseSearch();
                  return;
                }
                onClearSearch();
                searchInputRef.current?.focus();
              }}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
