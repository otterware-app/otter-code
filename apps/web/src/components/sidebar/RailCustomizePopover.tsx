import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useId, type ReactNode, type RefObject } from "react";

import { DragHandleIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup } from "../ui/popover";

export type RailCustomizeItem = {
  id: string;
  label: string;
  icon: ReactNode;
  visible: boolean;
  locked?: boolean;
};

function CustomizeRow({
  item,
  onVisibleChange,
}: {
  item: RailCustomizeItem;
  onVisibleChange: (visible: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative list-none", isDragging && "z-20 opacity-80")}
    >
      <div className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-ui text-foreground/90 hover:bg-sidebar-row-hover">
        <Checkbox
          checked={item.visible}
          disabled={item.locked === true}
          onCheckedChange={(checked) => onVisibleChange(Boolean(checked))}
          aria-label={
            item.locked
              ? `${item.label} is always shown`
              : item.visible
                ? `Hide ${item.label} from the rail`
                : `Show ${item.label} in the rail`
          }
        />
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {item.icon}
        </span>
        <span className="min-w-0 truncate">{item.label}</span>
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label={`Reorder ${item.label}`}
          className="ml-auto inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <DragHandleIcon className="size-3.5" />
        </button>
      </div>
    </li>
  );
}

function CustomizeList({
  items,
  onReorder,
  onVisibleChange,
}: {
  items: ReadonlyArray<RailCustomizeItem>;
  onReorder: (activeId: string, overId: string) => void;
  onVisibleChange: (id: string, visible: boolean) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragEnd={({ active, over }) => {
        if (over && active.id !== over.id) onReorder(String(active.id), String(over.id));
      }}
    >
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        <ul className="flex w-full min-w-0 flex-col gap-0.5">
          {items.map((item) => (
            <CustomizeRow
              key={item.id}
              item={item}
              onVisibleChange={(visible) => onVisibleChange(item.id, visible)}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

export function RailCustomizePopover({
  open,
  onOpenChange,
  anchor,
  items,
  shortcuts,
  onItemReorder,
  onItemVisibleChange,
  onShortcutReorder,
  onShortcutRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: RefObject<HTMLButtonElement | null>;
  items: ReadonlyArray<RailCustomizeItem>;
  shortcuts: ReadonlyArray<RailCustomizeItem>;
  onItemReorder: (activeId: string, overId: string) => void;
  onItemVisibleChange: (id: string, visible: boolean) => void;
  onShortcutReorder: (activeId: string, overId: string) => void;
  onShortcutRemove: (id: string) => void;
}) {
  const id = useId();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverPopup
        anchor={anchor}
        side="right"
        align="start"
        sideOffset={8}
        width="sm"
        padding="compact"
        aria-labelledby={id}
      >
        <div className="mb-1 flex items-center justify-between pl-2 pr-1">
          <h2 id={id} className="text-ui font-normal text-muted-foreground">
            Customize
          </h2>
          <Button size="xs" variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
        <CustomizeList
          items={items}
          onReorder={onItemReorder}
          onVisibleChange={onItemVisibleChange}
        />
        {shortcuts.length > 0 ? (
          <>
            <div className="px-2 pt-2.5 pb-1 text-ui text-muted-foreground">Shortcuts</div>
            <CustomizeList
              items={shortcuts}
              onReorder={onShortcutReorder}
              onVisibleChange={(key, visible) => {
                if (!visible) onShortcutRemove(key);
              }}
            />
          </>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
