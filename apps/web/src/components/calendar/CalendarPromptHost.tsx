import { useId, useState } from "react";

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
import { Radio, RadioGroup } from "../ui/radio-group";
import { type CalendarPrompt, answerCalendarPrompt, useCalendarPrompt } from "./calendarPrompts";

function PromptForm({ prompt }: { prompt: CalendarPrompt }) {
  const [value, setValue] = useState(prompt.defaultValue);
  const formId = useId();
  const asRadios = prompt.choices.length > 2;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{prompt.title}</DialogTitle>
        {prompt.description ? <DialogDescription>{prompt.description}</DialogDescription> : null}
      </DialogHeader>
      {asRadios ? (
        <DialogPanel scrollFade={false}>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              answerCalendarPrompt(value);
            }}
            // The radios are custom elements, which do not submit a form on Enter.
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              answerCalendarPrompt(value);
            }}
          >
            <RadioGroup
              aria-label={prompt.title}
              value={value}
              onValueChange={(next) => setValue(String(next))}
            >
              {prompt.choices.map((choice) => (
                <label key={choice.value} className="flex items-center gap-2.5 text-sm">
                  <Radio value={choice.value} autoFocus={choice.value === prompt.defaultValue} />
                  {choice.label}
                </label>
              ))}
            </RadioGroup>
          </form>
        </DialogPanel>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={() => answerCalendarPrompt(null)}>
          Cancel
        </Button>
        {asRadios ? (
          <Button type="submit" form={formId}>
            {prompt.confirmLabel}
          </Button>
        ) : (
          prompt.choices.map((choice) => (
            <Button
              key={choice.value}
              variant={choice.value === prompt.defaultValue ? "default" : "outline"}
              autoFocus={choice.value === prompt.defaultValue}
              onClick={() => answerCalendarPrompt(choice.value)}
            >
              {choice.label}
            </Button>
          ))
        )}
      </DialogFooter>
    </>
  );
}

/** Renders the open calendar question (recurring scope, notify guests); mounted once. */
export function CalendarPromptHost() {
  const prompt = useCalendarPrompt((state) => state.prompt);
  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) answerCalendarPrompt(null);
      }}
    >
      <DialogPopup showCloseButton={false} className="max-w-sm">
        {prompt ? <PromptForm key={prompt.title + prompt.defaultValue} prompt={prompt} /> : null}
      </DialogPopup>
    </Dialog>
  );
}
