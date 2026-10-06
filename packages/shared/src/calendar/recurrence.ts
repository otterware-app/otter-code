// @effect-diagnostics globalDate:off - Hot-path calendar math on epoch milliseconds; Date is only a UTC field codec here.
/**
 * Recurring events: the RFC 5545 subset Google Calendar produces (RRULE with FREQ
 * DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY with ordinals, BYMONTHDAY,
 * BYMONTH, BYSETPOS, WKST; EXDATE; RDATE), expanded on civil dates in the series' zone.
 *
 * Wall-clock times repeat in the event's own zone, so a 09:00 Berlin meeting stays at 09:00
 * Berlin across DST (and moves by an hour for a viewer in New York). The first occurrence is
 * always the series start, as in Google Calendar, and counts toward COUNT. Series without
 * COUNT jump straight to the requested window instead of iterating from the start, so a daily
 * meeting that began years ago costs the same as one that began last week.
 *
 * @module calendar/recurrence
 */
import {
  DAY_MS,
  MINUTE_MS,
  type DayNumber,
  addMonths,
  civilDate,
  dayNumber,
  daysInMonth,
  formatDayNumber,
  fromZoned,
  toZoned,
  weekday,
} from "./time.ts";

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface WeekdayRule {
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekday: number;
  /** 1 = first, -1 = last; absent for every such weekday. */
  readonly ordinal?: number;
}

export interface RecurrenceRule {
  readonly freq: Frequency;
  readonly interval: number;
  readonly count?: number;
  /** Inclusive bound: an instant, or for all-day series the UTC midnight of the last date. */
  readonly until?: number;
  readonly byDay?: ReadonlyArray<WeekdayRule>;
  readonly byMonthDay?: ReadonlyArray<number>;
  readonly byMonth?: ReadonlyArray<number>;
  readonly bySetPos?: ReadonlyArray<number>;
  readonly weekStart: number;
}

export interface RecurrenceSeries {
  /** First occurrence start: an instant, or for all-day series the date's UTC midnight. */
  readonly start: number;
  /** First occurrence end (exclusive). */
  readonly end: number;
  readonly allDay: boolean;
  /** The zone wall-clock repeats are evaluated in (ignored for all-day series). */
  readonly timeZone: string;
  /** RRULE / EXDATE / RDATE lines, as in Google's `recurrence` field. */
  readonly recurrence: ReadonlyArray<string>;
}

export interface Occurrence {
  /** Also the occurrence's original start, which identifies it (`occurrenceIdSuffix`). */
  readonly start: number;
  readonly end: number;
}

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const MAX_CANDIDATES = 200_000;

// ── Parsing ──────────────────────────────────────────────────────────

function parseList(value: string | undefined): Array<number> | undefined {
  if (value === undefined || value === "") return undefined;
  const numbers = value.split(",").map(Number);
  return numbers.every(Number.isFinite) ? numbers : undefined;
}

function parseDateValue(value: string, zone: string, allDay: boolean): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (match === null) return null;
  const day = dayNumber(Number(match[1]), Number(match[2]), Number(match[3]));
  if (match[4] === undefined) {
    // A date. For timed series it means the end of that day in the series' zone.
    return allDay ? day * DAY_MS : fromZoned(day + 1, 0, zone) - 1000;
  }
  const minutes = Number(match[4]) * 60 + Number(match[5]) + Number(match[6]) / 60;
  if (match[7] === "Z") return day * DAY_MS + minutes * MINUTE_MS;
  return fromZoned(day, minutes, zone);
}

/** Parses the `RRULE:` line's value (with or without the `RRULE:` prefix). */
function parseRecurrenceRule(
  line: string,
  context: { readonly allDay: boolean; readonly timeZone: string } = {
    allDay: false,
    timeZone: "UTC",
  },
): RecurrenceRule | null {
  const body = line.replace(/^RRULE:/i, "").trim();
  const parts = new Map<string, string>();
  for (const pair of body.split(";")) {
    const [key, value] = pair.split("=");
    if (key && value !== undefined) parts.set(key.trim().toUpperCase(), value.trim().toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    return null;
  }
  const interval = Math.max(1, Number(parts.get("INTERVAL") ?? 1) || 1);
  const countValue = parts.get("COUNT");
  const count = countValue === undefined ? undefined : Math.max(0, Number(countValue) || 0);
  const untilValue = parts.get("UNTIL");
  const until =
    untilValue === undefined
      ? undefined
      : (parseDateValue(untilValue, context.timeZone, context.allDay) ?? undefined);
  let byDay: Array<WeekdayRule> | undefined;
  const byDayValue = parts.get("BYDAY");
  if (byDayValue) {
    byDay = [];
    for (const token of byDayValue.split(",")) {
      const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token.trim());
      if (match === null) return null;
      const weekdayIndex = WEEKDAY_CODES.indexOf(match[2] as (typeof WEEKDAY_CODES)[number]);
      byDay.push(
        match[1] ? { weekday: weekdayIndex, ordinal: Number(match[1]) } : { weekday: weekdayIndex },
      );
    }
  }
  const weekStartCode = parts.get("WKST");
  const weekStart = weekStartCode
    ? Math.max(0, WEEKDAY_CODES.indexOf(weekStartCode as (typeof WEEKDAY_CODES)[number]))
    : 1;
  const byMonthDay = parseList(parts.get("BYMONTHDAY"));
  const byMonth = parseList(parts.get("BYMONTH"));
  const bySetPos = parseList(parts.get("BYSETPOS"));
  return {
    freq,
    interval,
    weekStart,
    ...(count === undefined ? {} : { count }),
    ...(until === undefined ? {} : { until }),
    ...(byDay === undefined ? {} : { byDay }),
    ...(byMonthDay === undefined ? {} : { byMonthDay }),
    ...(byMonth === undefined ? {} : { byMonth }),
    ...(bySetPos === undefined ? {} : { bySetPos }),
  };
}

/** Instants listed by EXDATE or RDATE lines (`EXDATE;TZID=Europe/Berlin:20261001T090000,…`). */
function parseDateList(line: string, zone: string, allDay: boolean): Array<number> {
  const colon = line.indexOf(":");
  if (colon < 0) return [];
  const params = line.slice(0, colon).split(";").slice(1);
  let valueZone = zone;
  for (const param of params) {
    const [key, value] = param.split("=");
    if (key?.toUpperCase() === "TZID" && value) valueZone = value;
  }
  const values: Array<number> = [];
  for (const raw of line.slice(colon + 1).split(",")) {
    const parsed = parseDateValue(raw, valueZone, allDay);
    if (parsed === null) continue;
    // A date-only EXDATE on a timed series names the day, matched below by day.
    values.push(parsed);
  }
  return values;
}

interface ParsedSeries {
  readonly rule: RecurrenceRule | null;
  readonly exdates: ReadonlySet<number>;
  readonly exdateDays: ReadonlySet<DayNumber>;
  readonly rdates: ReadonlyArray<number>;
}

function parseSeries(series: RecurrenceSeries): ParsedSeries {
  let rule: RecurrenceRule | null = null;
  const exdates = new Set<number>();
  const exdateDays = new Set<DayNumber>();
  const rdates: Array<number> = [];
  for (const line of series.recurrence) {
    const upper = line.slice(0, 6).toUpperCase();
    if (upper.startsWith("RRULE")) {
      rule ??= parseRecurrenceRule(line, series);
    } else if (upper.startsWith("EXDATE")) {
      const dateOnly = /VALUE=DATE[:;]/i.test(line) && !series.allDay;
      for (const value of parseDateList(line, series.timeZone, series.allDay || dateOnly)) {
        if (dateOnly) exdateDays.add(Math.floor(value / DAY_MS));
        else exdates.add(value);
      }
    } else if (upper.startsWith("RDATE")) {
      rdates.push(...parseDateList(line, series.timeZone, series.allDay));
    }
  }
  return { rule, exdates, exdateDays, rdates };
}

// ── Expansion ────────────────────────────────────────────────────────

/** Days of `year`/`month` matching BYDAY (with ordinals counted within the month). */
function monthDaysByWeekday(year: number, month: number, rules: ReadonlyArray<WeekdayRule>) {
  const first = dayNumber(year, month, 1);
  const length = daysInMonth(year, month);
  const days: Array<DayNumber> = [];
  for (const rule of rules) {
    const offset = (rule.weekday - weekday(first) + 7) % 7;
    const matches: Array<DayNumber> = [];
    for (let dom = 1 + offset; dom <= length; dom += 7) matches.push(first + dom - 1);
    if (rule.ordinal === undefined) days.push(...matches);
    else {
      const index = rule.ordinal > 0 ? rule.ordinal - 1 : matches.length + rule.ordinal;
      const match = matches[index];
      if (match !== undefined) days.push(match);
    }
  }
  return days;
}

function monthDaysByMonthDay(year: number, month: number, monthDays: ReadonlyArray<number>) {
  const length = daysInMonth(year, month);
  const first = dayNumber(year, month, 1);
  const days: Array<DayNumber> = [];
  for (const value of monthDays) {
    const dom = value > 0 ? value : length + value + 1;
    if (dom >= 1 && dom <= length) days.push(first + dom - 1);
  }
  return days;
}

function applySetPos(days: Array<DayNumber>, setPos: ReadonlyArray<number> | undefined) {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (setPos === undefined) return sorted;
  const picked: Array<DayNumber> = [];
  for (const position of setPos) {
    const day = position > 0 ? sorted[position - 1] : sorted[sorted.length + position];
    if (day !== undefined) picked.push(day);
  }
  return [...new Set(picked)].sort((a, b) => a - b);
}

function matchesFilters(day: DayNumber, rule: RecurrenceRule): boolean {
  if (rule.byMonth !== undefined && !rule.byMonth.includes(civilDate(day).month)) return false;
  if (rule.byMonthDay !== undefined) {
    const { year, month, day: dom } = civilDate(day);
    const length = daysInMonth(year, month);
    if (!rule.byMonthDay.some((value) => (value > 0 ? value : length + value + 1) === dom)) {
      return false;
    }
  }
  if (rule.byDay !== undefined && !rule.byDay.some((entry) => entry.weekday === weekday(day))) {
    return false;
  }
  return true;
}

/**
 * Candidate days of the period with index `period` (a day, a week, a month or a year after
 * the start's), before COUNT/UNTIL. Sorted ascending.
 */
function periodDays(rule: RecurrenceRule, startDay: DayNumber, period: number): Array<DayNumber> {
  switch (rule.freq) {
    case "DAILY": {
      const day = startDay + period * rule.interval;
      return matchesFilters(day, rule) ? [day] : [];
    }
    case "WEEKLY": {
      const weekStartDay =
        startDay - ((weekday(startDay) - rule.weekStart + 7) % 7) + period * rule.interval * 7;
      const weekdays = rule.byDay?.map((entry) => entry.weekday) ?? [weekday(startDay)];
      const days: Array<DayNumber> = [];
      for (let offset = 0; offset < 7; offset += 1) {
        const day = weekStartDay + offset;
        if (!weekdays.includes(weekday(day))) continue;
        if (rule.byMonth !== undefined && !rule.byMonth.includes(civilDate(day).month)) continue;
        days.push(day);
      }
      return applySetPos(days, rule.bySetPos);
    }
    case "MONTHLY": {
      const monthStart = addMonths(
        startDay - (civilDate(startDay).day - 1),
        period * rule.interval,
      );
      const { year, month } = civilDate(monthStart);
      if (rule.byMonth !== undefined && !rule.byMonth.includes(month)) return [];
      return applySetPos(monthCandidates(rule, year, month, startDay), rule.bySetPos);
    }
    case "YEARLY": {
      const { year: startYear, month: startMonth } = civilDate(startDay);
      const year = startYear + period * rule.interval;
      const months = rule.byMonth ?? [startMonth];
      const days: Array<DayNumber> = [];
      if (rule.byMonth === undefined && rule.byDay?.some((entry) => entry.ordinal !== undefined)) {
        // Ordinals count within the year (e.g. the 20th Monday).
        const first = dayNumber(year, 1, 1);
        const last = dayNumber(year, 12, 31);
        for (const entry of rule.byDay) {
          const matches: Array<DayNumber> = [];
          for (
            let day = first + ((entry.weekday - weekday(first) + 7) % 7);
            day <= last;
            day += 7
          ) {
            matches.push(day);
          }
          if (entry.ordinal === undefined) days.push(...matches);
          else {
            const match =
              matches[entry.ordinal > 0 ? entry.ordinal - 1 : matches.length + entry.ordinal];
            if (match !== undefined) days.push(match);
          }
        }
      } else {
        for (const month of months) days.push(...monthCandidates(rule, year, month, startDay));
      }
      return applySetPos(days, rule.bySetPos);
    }
  }
}

function monthCandidates(
  rule: RecurrenceRule,
  year: number,
  month: number,
  startDay: DayNumber,
): Array<DayNumber> {
  if (rule.byDay !== undefined && rule.byMonthDay !== undefined) {
    const byDay = new Set(monthDaysByWeekday(year, month, rule.byDay));
    return monthDaysByMonthDay(year, month, rule.byMonthDay).filter((day) => byDay.has(day));
  }
  if (rule.byDay !== undefined) return monthDaysByWeekday(year, month, rule.byDay);
  if (rule.byMonthDay !== undefined) return monthDaysByMonthDay(year, month, rule.byMonthDay);
  // Same day of month as the start; months without it are skipped (RFC 5545).
  const dom = civilDate(startDay).day;
  return dom <= daysInMonth(year, month) ? [dayNumber(year, month, dom)] : [];
}

/** How many periods lie wholly before `day`, so iteration can start near it. */
function periodsBefore(rule: RecurrenceRule, startDay: DayNumber, day: DayNumber): number {
  if (day <= startDay) return 0;
  switch (rule.freq) {
    case "DAILY":
      return Math.max(0, Math.floor((day - startDay) / rule.interval) - 1);
    case "WEEKLY":
      return Math.max(0, Math.floor((day - startDay) / (7 * rule.interval)) - 1);
    case "MONTHLY": {
      const a = civilDate(startDay);
      const b = civilDate(day);
      const months = (b.year - a.year) * 12 + (b.month - a.month);
      return Math.max(0, Math.floor(months / rule.interval) - 1);
    }
    case "YEARLY":
      return Math.max(
        0,
        Math.floor((civilDate(day).year - civilDate(startDay).year) / rule.interval) - 1,
      );
  }
}

/**
 * Occurrences overlapping [from, to), in start order. `limit` bounds the result for runaway
 * rules. A series without a parseable RRULE yields its first occurrence and its RDATEs.
 */
export function expandRecurrence(
  series: RecurrenceSeries,
  from: number,
  to: number,
  limit = 10_000,
): Array<Occurrence> {
  const duration = Math.max(0, series.end - series.start);
  const { rule, exdates, exdateDays, rdates } = parseSeries(series);
  const zone = series.allDay ? "UTC" : series.timeZone;
  const startLocal = series.allDay
    ? { day: Math.floor(series.start / DAY_MS), minutes: 0 }
    : toZoned(series.start, zone);
  const startDay = startLocal.day;
  const instantOf = (day: DayNumber) =>
    series.allDay ? day * DAY_MS : fromZoned(day, startLocal.minutes, zone);
  const excluded = (start: number) =>
    exdates.has(start) || (exdateDays.size > 0 && exdateDays.has(toZoned(start, zone).day));

  const starts = new Set<number>();
  const push = (start: number) => {
    if (start + Math.max(duration, 1) > from && start < to && !excluded(start)) starts.add(start);
  };

  push(series.start);
  for (const rdate of rdates) push(rdate);

  if (rule !== null && (rule.count === undefined || rule.count > 1)) {
    const until = rule.until ?? Number.POSITIVE_INFINITY;
    // Occurrences that start before `from` but still overlap it count too.
    const windowStartDay = Math.floor((from - duration) / DAY_MS) - 1;
    const windowEndDay = Math.floor(to / DAY_MS) + 1;
    let period = rule.count === undefined ? periodsBefore(rule, startDay, windowStartDay) : 0;
    let counted = 1;
    let candidates = 0;
    outer: while (candidates < MAX_CANDIDATES) {
      const days = periodDays(rule, startDay, period);
      period += 1;
      candidates += Math.max(1, days.length);
      if (days.length === 0) {
        if (periodLowerBound(rule, startDay, period) > windowEndDay) break;
        continue;
      }
      for (const day of days) {
        if (day <= startDay) continue;
        const start = instantOf(day);
        if (start > until) break outer;
        if (day > windowEndDay) break outer;
        counted += 1;
        if (rule.count !== undefined && counted > rule.count) break outer;
        push(start);
        if (starts.size >= limit) break outer;
      }
    }
  }

  return [...starts]
    .sort((a, b) => a - b)
    .slice(0, limit)
    .map((start) => ({ start, end: start + duration }));
}

/** The first day period `period` can contain, to stop iterating empty periods past the window. */
function periodLowerBound(rule: RecurrenceRule, startDay: DayNumber, period: number): DayNumber {
  switch (rule.freq) {
    case "DAILY":
      return startDay + period * rule.interval;
    case "WEEKLY":
      return startDay - 7 + period * rule.interval * 7;
    case "MONTHLY":
      return addMonths(startDay - (civilDate(startDay).day - 1), period * rule.interval);
    case "YEARLY":
      return dayNumber(civilDate(startDay).year + period * rule.interval, 1, 1);
  }
}

/**
 * When the series ends: the last occurrence's end, or null when it repeats forever. Used to
 * find the series that can reach a window.
 */
export function recurrenceEnd(series: RecurrenceSeries): number | null {
  const { rule, rdates } = parseSeries(series);
  const lastRdate = rdates.length > 0 ? Math.max(...rdates) : series.start;
  const duration = Math.max(0, series.end - series.start);
  if (rule === null) return Math.max(series.end, lastRdate + duration);
  if (rule.until !== undefined) return Math.max(rule.until + duration, lastRdate + duration);
  if (rule.count !== undefined) {
    const all = expandRecurrence(
      series,
      series.start,
      Number.MAX_SAFE_INTEGER,
      rule.count + rdates.length + 1,
    );
    const last = all.at(-1);
    return last === undefined ? series.end : last.end;
  }
  return null;
}

// ── Instance ids ─────────────────────────────────────────────────────

/** Google's instance id suffix: `20261001T090000Z` (timed) or `20261001` (all-day). */
function occurrenceIdSuffix(start: number, allDay: boolean): string {
  const date = new Date(start);
  const ymd = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  if (allDay) return ymd;
  return `${ymd}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** The instance id of an occurrence: `<seriesId>_<suffix>`. */
export function occurrenceId(seriesId: string, start: number, allDay: boolean): string {
  return `${seriesId}_${occurrenceIdSuffix(start, allDay)}`;
}

/** Splits an instance id into its series id and original start; null for other ids. */
export function parseOccurrenceId(
  eventId: string,
): { readonly seriesId: string; readonly start: number; readonly allDay: boolean } | null {
  const match = /^(.+)_(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(eventId);
  if (match === null) return null;
  const allDay = match[5] === undefined;
  const start = Date.UTC(
    Number(match[2]),
    Number(match[3]) - 1,
    Number(match[4]),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
    Number(match[7] ?? 0),
  );
  return { seriesId: match[1]!, start, allDay };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// ── Editing ──────────────────────────────────────────────────────────

function formatUntil(ms: number, allDay: boolean): string {
  return occurrenceIdSuffix(ms, allDay);
}

function withRuleParts(line: string, change: (parts: Map<string, string>) => void): string {
  const parts = new Map<string, string>();
  for (const pair of line.replace(/^RRULE:/i, "").split(";")) {
    const [key, value] = pair.split("=");
    if (key && value !== undefined) parts.set(key.trim().toUpperCase(), value.trim());
  }
  change(parts);
  return `RRULE:${[...parts].map(([key, value]) => `${key}=${value}`).join(";")}`;
}

/**
 * The recurrence lines that end a series just before the occurrence starting at `splitStart`
 * ("this and following" keeps the earlier part in the original series).
 */
export function recurrenceBefore(series: RecurrenceSeries, splitStart: number): Array<string> {
  const lastDay = Math.floor(splitStart / DAY_MS) - 1;
  const until = series.allDay ? lastDay * DAY_MS : splitStart - 1000;
  return series.recurrence.flatMap((line) => {
    const upper = line.toUpperCase();
    if (upper.startsWith("RRULE")) {
      return [
        withRuleParts(line, (parts) => {
          parts.delete("COUNT");
          parts.set("UNTIL", formatUntil(until, series.allDay));
        }),
      ];
    }
    if (upper.startsWith("RDATE") || upper.startsWith("EXDATE")) {
      const kept = filterDateLine(line, series, (value) => value < splitStart);
      return kept === null ? [] : [kept];
    }
    return [line];
  });
}

/**
 * The recurrence lines for the new series that continues from the occurrence starting at
 * `splitStart`: COUNT shrinks by the occurrences left behind, earlier EXDATE/RDATE go away.
 */
export function recurrenceFrom(series: RecurrenceSeries, splitStart: number): Array<string> {
  const { rule } = parseSeries(series);
  let remaining: number | undefined;
  if (rule?.count !== undefined) {
    const before = expandRecurrence(series, series.start, splitStart, rule.count + 1).filter(
      (occurrence) => occurrence.start < splitStart,
    ).length;
    remaining = Math.max(1, rule.count - before);
  }
  return series.recurrence.flatMap((line) => {
    const upper = line.toUpperCase();
    if (upper.startsWith("RRULE")) {
      return [
        withRuleParts(line, (parts) => {
          if (remaining !== undefined) parts.set("COUNT", String(remaining));
        }),
      ];
    }
    if (upper.startsWith("RDATE") || upper.startsWith("EXDATE")) {
      const kept = filterDateLine(line, series, (value) => value >= splitStart);
      return kept === null ? [] : [kept];
    }
    return [line];
  });
}

function filterDateLine(
  line: string,
  series: RecurrenceSeries,
  keep: (value: number) => boolean,
): string | null {
  const colon = line.indexOf(":");
  if (colon < 0) return line;
  const head = line.slice(0, colon);
  let zone = series.timeZone;
  for (const param of head.split(";").slice(1)) {
    const [key, value] = param.split("=");
    if (key?.toUpperCase() === "TZID" && value) zone = value;
  }
  const values = line
    .slice(colon + 1)
    .split(",")
    .filter((raw) => {
      const parsed = parseDateValue(raw, zone, series.allDay);
      return parsed === null || keep(parsed);
    });
  return values.length === 0 ? null : `${head}:${values.join(",")}`;
}

// ── Building and describing rules (the editor's repeat picker) ───────

export interface RepeatOptions {
  readonly freq: Frequency;
  readonly interval?: number;
  /** Weekdays for weekly rules (0 = Sunday). */
  readonly weekdays?: ReadonlyArray<number>;
  /** Monthly by weekday ordinal ("the second Tuesday") instead of by day of month. */
  readonly monthlyByWeekday?: boolean;
  readonly count?: number;
  /** Last date, inclusive (`YYYY-MM-DD` as a day number). */
  readonly untilDay?: DayNumber;
}

/**
 * An RRULE line for the editor's choices, anchored on the event's start (its day of month and
 * weekday). `untilDay` ends the series at the end of that local day.
 */
export function buildRecurrenceRule(
  options: RepeatOptions,
  anchor: { readonly start: number; readonly allDay: boolean; readonly timeZone: string },
): string {
  const parts: Array<string> = [`FREQ=${options.freq}`];
  if ((options.interval ?? 1) > 1) parts.push(`INTERVAL=${options.interval}`);
  const zone = anchor.allDay ? "UTC" : anchor.timeZone;
  const startDay = anchor.allDay
    ? Math.floor(anchor.start / DAY_MS)
    : toZoned(anchor.start, zone).day;
  if (options.freq === "WEEKLY" && options.weekdays && options.weekdays.length > 0) {
    const sorted = [...new Set(options.weekdays)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    parts.push(`BYDAY=${sorted.map((day) => WEEKDAY_CODES[day]).join(",")}`);
  }
  if (options.freq === "MONTHLY" && options.monthlyByWeekday) {
    const { day: dom, year, month } = civilDate(startDay);
    const nth = Math.ceil(dom / 7);
    const isLast = dom + 7 > daysInMonth(year, month);
    parts.push(
      `BYDAY=${nth >= 5 || (nth === 4 && isLast) ? -1 : nth}${WEEKDAY_CODES[weekday(startDay)]}`,
    );
  }
  if (options.count !== undefined) parts.push(`COUNT=${options.count}`);
  else if (options.untilDay !== undefined) {
    const until = anchor.allDay
      ? options.untilDay * DAY_MS
      : fromZoned(options.untilDay + 1, 0, zone) - 1000;
    parts.push(`UNTIL=${formatUntil(until, anchor.allDay)}`);
  }
  return `RRULE:${parts.join(";")}`;
}

/** The editor's choices read back from a rule, or null for rules the picker cannot show. */
export function repeatOptionsOf(
  recurrence: ReadonlyArray<string>,
  anchor: { readonly allDay: boolean; readonly timeZone: string },
): RepeatOptions | null {
  const line = recurrence.find((entry) => entry.toUpperCase().startsWith("RRULE"));
  if (line === undefined) return null;
  const rule = parseRecurrenceRule(line, anchor);
  if (rule === null || rule.byMonth !== undefined || rule.bySetPos !== undefined) return null;
  if (rule.byMonthDay !== undefined) return null;
  const untilDay =
    rule.until === undefined
      ? undefined
      : anchor.allDay
        ? Math.floor(rule.until / DAY_MS)
        : toZoned(rule.until, anchor.timeZone).day;
  return {
    freq: rule.freq,
    interval: rule.interval,
    ...(rule.freq === "WEEKLY" && rule.byDay
      ? { weekdays: rule.byDay.map((entry) => entry.weekday) }
      : {}),
    ...(rule.freq === "MONTHLY" && rule.byDay ? { monthlyByWeekday: true } : {}),
    ...(rule.count === undefined ? {} : { count: rule.count }),
    ...(untilDay === undefined ? {} : { untilDay }),
  };
}

const ORDINALS = ["", "first", "second", "third", "fourth", "fifth"];

/** "Weekly on Monday and Wednesday", "Every 2 weeks on Friday, 10 times", "Monthly on the last Friday". */
export function describeRecurrence(
  recurrence: ReadonlyArray<string>,
  anchor: { readonly start: number; readonly allDay: boolean; readonly timeZone: string },
  locale = "en-US",
): string {
  const line = recurrence.find((entry) => entry.toUpperCase().startsWith("RRULE"));
  if (line === undefined) return recurrence.length > 0 ? "Custom" : "Does not repeat";
  const rule = parseRecurrenceRule(line, anchor);
  if (rule === null) return "Custom";
  const zone = anchor.allDay ? "UTC" : anchor.timeZone;
  const startDay = anchor.allDay
    ? Math.floor(anchor.start / DAY_MS)
    : toZoned(anchor.start, zone).day;
  const weekdayName = (day: number) =>
    new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
      new Date((3 + day) * DAY_MS),
    );
  const list = (items: Array<string>) =>
    items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  const every = (unit: string, plural: string) =>
    rule.interval === 1 ? unit : `Every ${rule.interval} ${plural}`;

  let text: string;
  switch (rule.freq) {
    case "DAILY":
      text = every("Daily", "days");
      break;
    case "WEEKLY": {
      const days = rule.byDay?.map((entry) => entry.weekday) ?? [weekday(startDay)];
      const sorted = [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      const isWeekdays =
        sorted.length === 5 && [1, 2, 3, 4, 5].every((day) => sorted.includes(day));
      text =
        rule.interval === 1 && isWeekdays
          ? "Every weekday"
          : `${every("Weekly", "weeks")} on ${list(sorted.map(weekdayName))}`;
      break;
    }
    case "MONTHLY": {
      const byDay = rule.byDay?.[0];
      if (byDay?.ordinal !== undefined) {
        const ordinal =
          byDay.ordinal === -1 ? "last" : (ORDINALS[byDay.ordinal] ?? `${byDay.ordinal}th`);
        text = `${every("Monthly", "months")} on the ${ordinal} ${weekdayName(byDay.weekday)}`;
      } else if (rule.byMonthDay !== undefined) {
        text = `${every("Monthly", "months")} on day ${rule.byMonthDay.join(", ")}`;
      } else {
        text = `${every("Monthly", "months")} on day ${civilDate(startDay).day}`;
      }
      break;
    }
    case "YEARLY": {
      const date = new Intl.DateTimeFormat(locale, {
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date(startDay * DAY_MS));
      text = `${every("Annually", "years")} on ${date}`;
      break;
    }
  }
  if (rule.count !== undefined) text += `, ${rule.count} time${rule.count === 1 ? "" : "s"}`;
  else if (rule.until !== undefined) {
    const untilDay = anchor.allDay
      ? Math.floor(rule.until / DAY_MS)
      : toZoned(rule.until, zone).day;
    const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(untilDay * DAY_MS),
    );
    text += `, until ${date}`;
  }
  return text;
}
