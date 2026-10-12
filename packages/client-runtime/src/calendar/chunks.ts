/**
 * Week chunks a view subscribes to (`CalendarWeekInput.week`): 7 UTC days starting on a Monday
 * at 00:00 UTC, keyed by that Monday as `YYYY-MM-DD`.
 *
 * The contract's rule is "every chunk overlapping the view's dates, padded by a day on each
 * side", which covers a view in any zone. `chunkWeeksForDays` computes that cover from the
 * actual zone instead: the view needs instants from the start of its first local day to the end
 * of its last one (timed events), and UTC-midnight dates for its days (all-day events). That is
 * always inside the padded range, and saves the third chunk the padding adds to most weeks.
 *
 * @module calendar/chunks
 */
import {
  DAY_MS,
  type DayNumber,
  endOfZonedDay,
  formatDayNumber,
  parseDayNumber,
  startOfZonedDay,
} from "@t3tools/shared/calendar/time";

/** The Monday (UTC) of the chunk containing a UTC day. */
function chunkMonday(utcDay: DayNumber): DayNumber {
  // 1970-01-01 was a Thursday; Monday is weekday 1.
  return utcDay - ((((utcDay + 3) % 7) + 7) % 7);
}

/** The chunk key (`YYYY-MM-DD` of its Monday) of a UTC day. */
export function chunkKey(utcDay: DayNumber): string {
  return formatDayNumber(chunkMonday(utcDay));
}

/** The chunk's instant range [start, end) in epoch ms; null for a malformed key. */
export function chunkRange(week: string): { readonly start: number; readonly end: number } | null {
  const monday = parseDayNumber(week);
  if (monday === null) return null;
  return { start: monday * DAY_MS, end: (monday + 7) * DAY_MS };
}

/**
 * Chunk keys covering local days [firstDay, lastDay] in `timeZone`, ascending. Without a zone,
 * the zone-independent cover (the range padded by a day on each side).
 */
export function chunkWeeksForDays(
  firstDay: DayNumber,
  lastDay: DayNumber,
  timeZone?: string,
): string[] {
  let fromUtcDay: DayNumber;
  let toUtcDay: DayNumber;
  if (timeZone === undefined) {
    fromUtcDay = firstDay - 1;
    toUtcDay = lastDay + 1;
  } else {
    const start = Math.min(startOfZonedDay(firstDay, timeZone), firstDay * DAY_MS);
    const end = Math.max(endOfZonedDay(lastDay, timeZone), (lastDay + 1) * DAY_MS);
    fromUtcDay = Math.floor(start / DAY_MS);
    toUtcDay = Math.floor((end - 1) / DAY_MS);
  }
  const weeks: string[] = [];
  for (let monday = chunkMonday(fromUtcDay); monday <= toUtcDay; monday += 7) {
    weeks.push(formatDayNumber(monday));
  }
  return weeks;
}

/** The `count` chunks before and after a run of chunk keys, for prefetching. */
export function neighbourChunkWeeks(
  weeks: ReadonlyArray<string>,
  count = 1,
): { readonly before: string[]; readonly after: string[] } {
  const mondays = weeks
    .map(parseDayNumber)
    .filter((day): day is DayNumber => day !== null)
    .sort((a, b) => a - b);
  if (mondays.length === 0) return { before: [], after: [] };
  const first = mondays[0]!;
  const last = mondays[mondays.length - 1]!;
  const before: string[] = [];
  const after: string[] = [];
  for (let step = count; step >= 1; step--) before.push(formatDayNumber(first - 7 * step));
  for (let step = 1; step <= count; step++) after.push(formatDayNumber(last + 7 * step));
  return { before, after };
}
