import { useId, useState, type KeyboardEvent } from "react";

import { SPACE_ICON_OPTIONS } from "../../projectSpaces";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SpaceIcon } from "./SpaceIcon";

export function SpaceEditorDialog({
  initialValue,
  existingNames,
  onClose,
  onSave,
}: {
  initialValue?: { name: string; icon: string };
  existingNames: ReadonlyArray<string>;
  onClose: () => void;
  onSave: (value: { name: string; icon: string }) => void;
}) {
  const [name, setName] = useState(initialValue?.name ?? "");
  const [icon, setIcon] = useState(initialValue?.icon ?? "bag");
  const nameId = useId();
  const trimmedName = name.trim();
  const duplicate = existingNames.some(
    (value) => value.toLocaleLowerCase() === trimmedName.toLocaleLowerCase(),
  );
  const canSave = trimmedName.length > 0 && !duplicate;

  const save = () => {
    if (!canSave) return;
    onSave({ name: trimmedName, icon });
    onClose();
  };

  const onIconKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key))
      return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]"),
    );
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current +
              (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) +
              buttons.length) %
            buttons.length;
    event.preventDefault();
    buttons[next]?.click();
    buttons[next]?.focus();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{initialValue ? "Edit space" : "New space"}</DialogTitle>
          <DialogDescription>
            {initialValue
              ? "Rename this space or give it a different icon. Its projects stay where they are."
              : "Group projects into a focused work context."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor={nameId} className="block text-xs font-medium text-foreground">
                Name
              </label>
              <Input
                id={nameId}
                autoFocus
                value={name}
                maxLength={64}
                placeholder="Work"
                aria-invalid={duplicate}
                aria-describedby={duplicate ? `${nameId}-error` : undefined}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    save();
                  }
                }}
              />
              {duplicate ? (
                <p id={`${nameId}-error`} role="alert" className="text-xs text-destructive">
                  That name is already taken.
                </p>
              ) : null}
            </div>
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-foreground">Icon</legend>
              <div
                role="radiogroup"
                aria-label="Space icon"
                onKeyDown={onIconKeyDown}
                className="grid grid-cols-10 gap-1.5 max-sm:grid-cols-5"
              >
                {SPACE_ICON_OPTIONS.map((option) => (
                  <button
                    key={option.name}
                    type="button"
                    role="radio"
                    aria-label={option.label}
                    aria-checked={icon === option.name}
                    tabIndex={icon === option.name ? 0 : -1}
                    onClick={() => setIcon(option.name)}
                    className={cn(
                      "flex aspect-square cursor-pointer items-center justify-center rounded-lg border text-muted-foreground outline-hidden hover:bg-foreground/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
                      icon === option.name
                        ? "border-foreground/25 bg-foreground/9 text-foreground"
                        : "border-transparent bg-foreground/3",
                    )}
                  >
                    <SpaceIcon icon={option.name} />
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={save}>
            {initialValue ? "Save" : "Create space"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
