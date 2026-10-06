/** Fields of the event editor: date, time (typed or picked in 15-minute steps), zone, guests. */
import {
  type HourFormat,
  formatDuration,
  formatMinutes,
  formatZoneName,
} from "@t3tools/client-runtime/calendar/format";
import type { CalendarAttendee } from "@t3tools/contracts";
import { type DayNumber, formatDayNumber, parseDayNumber } from "@t3tools/shared/calendar/time";
import { XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { normalizeSearchText } from "../../lib/utils";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { isEmail, parseTimeText, TIME_STEP_MINUTES } from "./eventEditor.logic";

export function DateField({
  label,
  day,
  onChange,
}: {
  label: string;
  day: DayNumber;
  onChange: (day: DayNumber) => void;
}) {
  return (
    <Input
      type="date"
      nativeInput
      size="sm"
      aria-label={label}
      value={formatDayNumber(day)}
      onChange={(event) => {
        const parsed = parseDayNumber(event.target.value);
        if (parsed !== null) onChange(parsed);
      }}
    />
  );
}

interface TimeSlot {
  readonly minutes: number;
  readonly label: string;
  readonly hint: string | null;
}

/**
 * A time typed ("930", "2:30 pm") or picked from 15-minute steps. The end field lists the
 * times after `from` with the duration next to each.
 */
export function TimeField({
  label,
  minutes,
  hourFormat,
  from,
  onCommit,
}: {
  label: string;
  minutes: number;
  hourFormat: HourFormat;
  /** Start minutes, for the end field: lists later times with durations. */
  from?: number;
  onCommit: (minutes: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const formatted = formatMinutes(minutes, hourFormat);
  const slots = useMemo((): ReadonlyArray<TimeSlot> => {
    const first =
      from === undefined
        ? Math.floor(minutes / TIME_STEP_MINUTES) * TIME_STEP_MINUTES
        : from + TIME_STEP_MINUTES;
    return Array.from({ length: 96 }, (_, index) => {
      const offset = first + index * TIME_STEP_MINUTES;
      const wall = ((offset % 1440) + 1440) % 1440;
      return {
        minutes: wall,
        label: formatMinutes(wall, hourFormat),
        hint: from === undefined ? null : formatDuration(offset - from),
      };
    });
  }, [from, hourFormat, minutes]);
  const query = text === null || text === formatted ? "" : normalizeSearchText(text);
  const items = query
    ? slots.filter((slot) =>
        normalizeSearchText(slot.label).replace(/\s/g, "").startsWith(query.replace(/\s/g, "")),
      )
    : slots;
  const commitText = () => {
    if (text === null) return;
    const parsed = parseTimeText(text);
    setText(null);
    if (parsed !== null && parsed !== minutes) onCommit(parsed);
  };
  return (
    <Autocomplete
      items={items}
      itemToStringValue={(slot: TimeSlot) => slot.label}
      mode="none"
      openOnInputClick
      value={text ?? formatted}
      onValueChange={(value, details) => {
        if (details.reason === "item-press") {
          const slot = slots.find((candidate) => candidate.label === value);
          setText(null);
          if (slot !== undefined && slot.minutes !== minutes) onCommit(slot.minutes);
          return;
        }
        setText(value);
      }}
    >
      <AutocompleteInput
        aria-label={label}
        size="sm"
        spellCheck={false}
        onBlur={commitText}
        onKeyDown={(event) => {
          if (event.key === "Enter" && text !== null && parseTimeText(text) !== null) {
            event.preventDefault();
            commitText();
          } else if (event.key === "Escape" && text !== null) {
            event.stopPropagation();
            setText(null);
          }
        }}
      />
      <AutocompletePopup>
        <AutocompleteList className="max-h-60">
          {items.map((slot) => (
            <AutocompleteItem key={slot.minutes} value={slot}>
              <span className="tabular-nums">{slot.label}</span>
              {slot.hint ? (
                <span className="ms-auto text-xs text-muted-foreground">{slot.hint}</span>
              ) : null}
            </AutocompleteItem>
          ))}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  );
}

let zoneList: ReadonlyArray<string> | null = null;

function allZones(): ReadonlyArray<string> {
  if (zoneList === null) {
    try {
      zoneList = Intl.supportedValuesOf("timeZone");
    } catch {
      zoneList = ["UTC"];
    }
    if (!zoneList.includes("UTC")) zoneList = [...zoneList, "UTC"];
  }
  return zoneList;
}

function zoneLabel(zone: string, at: number): string {
  return `${zone.replace(/_/g, " ")} (${formatZoneName(zone, at)})`;
}

/** A searchable list of IANA zones. */
export function TimeZoneField({
  label,
  zone,
  at,
  onChange,
}: {
  label: string;
  zone: string;
  /** The instant offsets are shown for (DST differs through the year). */
  at: number;
  onChange: (zone: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const current = zoneLabel(zone, at);
  const query = text === null || text === current ? "" : normalizeSearchText(text);
  const items = useMemo(() => {
    const zones = allZones();
    const matches = query
      ? zones.filter((candidate) =>
          normalizeSearchText(candidate.replace(/_/g, " ")).includes(query),
        )
      : zones;
    return matches.slice(0, 60);
  }, [query]);
  return (
    <Autocomplete
      items={items}
      itemToStringValue={(candidate: string) => zoneLabel(candidate, at)}
      mode="none"
      openOnInputClick
      value={text ?? current}
      onValueChange={(value, details) => {
        if (details.reason === "item-press") {
          const picked = items.find((candidate) => zoneLabel(candidate, at) === value);
          setText(null);
          if (picked !== undefined && picked !== zone) onChange(picked);
          return;
        }
        setText(value);
      }}
    >
      <AutocompleteInput
        aria-label={label}
        size="sm"
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => setText(null)}
      />
      <AutocompletePopup>
        <AutocompleteList className="max-h-60">
          {items.map((candidate) => (
            <AutocompleteItem key={candidate} value={candidate}>
              <span className="min-w-0 truncate">{candidate.replace(/_/g, " ")}</span>
              <span className="ms-auto shrink-0 text-xs text-muted-foreground">
                {formatZoneName(candidate, at)}
              </span>
            </AutocompleteItem>
          ))}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  );
}

const RESPONSE_LABELS: Record<CalendarAttendee["responseStatus"], string> = {
  accepted: "Going",
  tentative: "Maybe",
  declined: "Not going",
  needsAction: "Awaiting",
};

/** Guest emails as chips; Enter, comma or Tab adds, Backspace on an empty field removes. */
export function GuestsField({
  guests,
  known,
  onChange,
}: {
  guests: ReadonlyArray<string>;
  /** Attendees as the server knows them, for their reply. */
  known: ReadonlyArray<CalendarAttendee>;
  onChange: (guests: ReadonlyArray<string>) => void;
}) {
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const add = (): boolean => {
    const emails = draft
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (emails.length === 0) return false;
    if (!emails.every(isEmail)) {
      setInvalid(true);
      return false;
    }
    const next = [...guests];
    for (const email of emails) {
      if (!next.some((guest) => guest.toLowerCase() === email.toLowerCase())) next.push(email);
    }
    onChange(next);
    setDraft("");
    setInvalid(false);
    return true;
  };
  return (
    <div className="flex flex-col gap-1.5">
      {guests.length > 0 ? (
        <ul className="flex flex-col gap-0.5" aria-label="Guests">
          {guests.map((guest) => {
            const attendee = known.find(
              (candidate) => candidate.email.toLowerCase() === guest.toLowerCase(),
            );
            return (
              <li key={guest} className="group/guest flex min-w-0 items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{attendee?.displayName || guest}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {attendee ? RESPONSE_LABELS[attendee.responseStatus] : "New"}
                </span>
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={`Remove ${guest}`}
                  onClick={() => onChange(guests.filter((candidate) => candidate !== guest))}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Input
        size="sm"
        type="email"
        placeholder="Add guests by email"
        aria-label="Add guests"
        aria-invalid={invalid || undefined}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onBlur={() => {
          if (draft.trim()) add();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            if (draft.trim()) {
              event.preventDefault();
              add();
            }
          } else if (event.key === "Tab" && draft.trim()) {
            if (add()) event.preventDefault();
          } else if (event.key === "Backspace" && draft === "" && guests.length > 0) {
            onChange(guests.slice(0, -1));
          }
        }}
      />
    </div>
  );
}
