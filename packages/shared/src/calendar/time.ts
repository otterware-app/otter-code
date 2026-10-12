// @effect-diagnostics globalDate:off - Hot-path calendar math on epoch milliseconds; Date is only a UTC field codec here.
/**
 * Calendar time math shared by the server (recurrence expansion) and the clients (rendering).
 *
 * Two representations, and nothing else:
 * - Instants are epoch milliseconds (UTC).
 * - Civil dates are day numbers: whole days since 1970-01-01, zone-free. Calendar arithmetic
 *   (next day, next month, weekday) happens on day numbers, so it never crosses a DST edge.
 *
 * A zone turns one into the other. Offsets come from `Intl.DateTimeFormat` and are cached per
 * zone and UTC day (a day has at most one transition), so converting thousands of instants per
 * frame costs a map lookup each. Wall times that do not exist (spring-forward gaps) resolve
 * forward and ambiguous ones (fall-back overlaps) resolve to the earlier instant, like
 * Temporal's `compatible` disambiguation and Google Calendar.
 *
 * @module calendar/time
 */

export const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
const MINUTES_PER_DAY = 1440;

/** Days since 1970-01-01 (a civil date, independent of any zone). */
export type DayNumber = number;

export interface CivilDate {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  /** 1–31. */
  readonly day: number;
}

// ── Civil dates ──────────────────────────────────────────────────────

export function dayNumber(year: number, month: number, day: number): DayNumber {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function civilDate(day: DayNumber): CivilDate {
  const date = new Date(day * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(day: DayNumber): number {
  // 1970-01-01 was a Thursday.
  return (((day + 4) % 7) + 7) % 7;
}

export function startOfWeek(day: DayNumber, weekStartsOn: number): DayNumber {
  return day - ((weekday(day) - weekStartsOn + 7) % 7);
}

export function startOfMonth(day: DayNumber): DayNumber {
  const { year, month } = civilDate(day);
  return dayNumber(year, month, 1);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Adds months, clamping the day of month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(day: DayNumber, months: number): DayNumber {
  const { year, month, day: dom } = civilDate(day);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = index - targetYear * 12 + 1;
  return dayNumber(targetYear, targetMonth, Math.min(dom, daysInMonth(targetYear, targetMonth)));
}

/** `YYYY-MM-DD`. */
export function formatDayNumber(day: DayNumber): string {
  const { year, month, day: dom } = civilDate(day);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(dom).padStart(2, "0")}`;
}

/** Parses `YYYY-MM-DD`; null when malformed or not a real date. */
export function parseDayNumber(value: string): DayNumber | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return dayNumber(year, month, day);
}

/** The floating date of an all-day instant (UTC midnight) as a day number. */
export function dayOfUtcMidnight(ms: number): DayNumber {
  return Math.floor(ms / DAY_MS);
}

// ── Zones ────────────────────────────────────────────────────────────

const UTC_ZONES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Z"]);

let cachedSystemZone: string | null = null;

/** The device's zone, read once per process. */
export function systemTimeZone(): string {
  cachedSystemZone ??= new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return cachedSystemZone;
}

const validZones = new Map<string, boolean>();

export function isValidTimeZone(zone: string): boolean {
  let valid = validZones.get(zone);
  if (valid === undefined) {
    try {
      valid =
        new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone !== "";
    } catch {
      valid = false;
    }
    validZones.set(zone, valid);
  }
  return valid;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      era: "short",
    });
    partsFormatters.set(zone, formatter);
  }
  return formatter;
}

/** The zone's UTC offset at an instant, computed with Intl (uncached). */
function computeOffset(zone: string, ms: number): number {
  const parts = partsFormatter(zone).formatToParts(new Date(ms));
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let bc = false;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
      case "era":
        bc = part.value === "BC" || part.value === "B";
        break;
    }
  }
  if (bc) year = 1 - year;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const wholeSecond = Math.floor(ms / 1000) * 1000;
  return date.getTime() - wholeSecond;
}

interface DayOffsets {
  /** Offset at the start of the UTC day. */
  readonly start: number;
  /** Offset at the end of the UTC day. */
  readonly end: number;
  /** First instant (ms) with the `end` offset, when the day has a transition. */
  readonly transition: number;
}

const zoneDayCache = new Map<string, Map<number, DayOffsets>>();
const MAX_CACHED_DAYS_PER_ZONE = 20_000;

function dayOffsets(zone: string, utcDay: number): DayOffsets {
  let days = zoneDayCache.get(zone);
  if (days === undefined) {
    days = new Map();
    zoneDayCache.set(zone, days);
  }
  let offsets = days.get(utcDay);
  if (offsets === undefined) {
    const dayStart = utcDay * DAY_MS;
    const start = computeOffset(zone, dayStart);
    const end = computeOffset(zone, dayStart + DAY_MS - 1);
    let transition = dayStart + DAY_MS;
    if (start !== end) {
      // Binary search to the minute: transitions happen on whole minutes.
      let low = 0;
      let high = MINUTES_PER_DAY;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (computeOffset(zone, dayStart + mid * MINUTE_MS) === start) low = mid + 1;
        else high = mid;
      }
      transition = dayStart + low * MINUTE_MS;
    }
    offsets = { start, end, transition };
    if (days.size >= MAX_CACHED_DAYS_PER_ZONE) days.clear();
    days.set(utcDay, offsets);
  }
  return offsets;
}

/** Milliseconds to add to an instant to get the zone's wall-clock time as if it were UTC. */
export function zoneOffset(zone: string, ms: number): number {
  if (UTC_ZONES.has(zone)) return 0;
  const offsets = dayOffsets(zone, Math.floor(ms / DAY_MS));
  return ms < offsets.transition ? offsets.start : offsets.end;
}

export interface ZonedTime {
  /** The local civil date. */
  readonly day: DayNumber;
  /** Minutes after local midnight, 0–1439 (fractions for sub-minute instants). */
  readonly minutes: number;
}

/** The wall-clock date and time of an instant in a zone. */
export function toZoned(ms: number, zone: string): ZonedTime {
  const local = ms + zoneOffset(zone, ms);
  const day = Math.floor(local / DAY_MS);
  return { day, minutes: (local - day * DAY_MS) / MINUTE_MS };
}

/** The local civil date of an instant in a zone. */
export function zonedDay(ms: number, zone: string): DayNumber {
  return Math.floor((ms + zoneOffset(zone, ms)) / DAY_MS);
}

/**
 * The instant of a wall-clock time in a zone. Times in a spring-forward gap move forward by the
 * gap; times in a fall-back overlap resolve to the earlier instant.
 */
export function fromZoned(day: DayNumber, minutes: number, zone: string): number {
  const local = day * DAY_MS + minutes * MINUTE_MS;
  if (UTC_ZONES.has(zone)) return local;
  const guess = local - zoneOffset(zone, local);
  const offset = zoneOffset(zone, guess);
  const candidate = local - offset;
  // No zone has two transitions within six hours, so this is the offset before any nearby one.
  const before = zoneOffset(zone, candidate - 6 * HOUR_MS);
  if (zoneOffset(zone, candidate) === offset) {
    if (before !== offset) {
      const earlier = local - before;
      if (earlier < candidate && zoneOffset(zone, earlier) === before) return earlier;
    }
    return candidate;
  }
  // A gap: the wall time does not exist. Keep the pre-transition offset, which lands after it.
  return local - before;
}

/** The instant a local day starts (usually midnight; later when midnight falls in a gap). */
export function startOfZonedDay(day: DayNumber, zone: string): number {
  return fromZoned(day, 0, zone);
}

/** The instant a local day ends (the next day's start). */
export function endOfZonedDay(day: DayNumber, zone: string): number {
  return fromZoned(day + 1, 0, zone);
}

// ── Instants as strings ──────────────────────────────────────────────

/** Formats an instant as an ISO string with the zone's offset, e.g. `2026-10-01T09:00:00+02:00`. */
export function formatZonedIso(ms: number, zone: string): string {
  const offset = zoneOffset(zone, ms);
  const { day, minutes } = toZoned(ms, zone);
  const whole = Math.floor(minutes);
  const seconds = Math.floor((((ms % MINUTE_MS) + MINUTE_MS) % MINUTE_MS) / 1000);
  const sign = offset < 0 ? "-" : "+";
  const offsetMinutes = Math.abs(Math.round(offset / MINUTE_MS));
  return `${formatDayNumber(day)}T${pad2(Math.floor(whole / 60))}:${pad2(whole % 60)}:${pad2(seconds)}${sign}${pad2(Math.floor(offsetMinutes / 60))}:${pad2(offsetMinutes % 60)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Parses an ISO 8601 instant. A string without an offset is read as wall time in `zone`
 * (defaulting to UTC). Null when malformed.
 */
export function parseInstant(value: string, zone = "UTC"): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      value.trim(),
    );
  if (match === null) return null;
  const day = parseDayNumber(`${match[1]}-${match[2]}-${match[3]}`);
  if (day === null) return null;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const millis = Number((match[7] ?? "0").padEnd(3, "0").slice(0, 3));
  if (hour > 24 || minute > 59 || second > 60) return null;
  const minutes = hour * 60 + minute + (second * 1000 + millis) / MINUTE_MS;
  const designator = match[8];
  if (designator === undefined) return fromZoned(day, minutes, zone);
  if (designator.toUpperCase() === "Z") return day * DAY_MS + minutes * MINUTE_MS;
  const sign = designator.startsWith("-") ? -1 : 1;
  const digits = designator.slice(1).replace(":", "");
  const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  return day * DAY_MS + (minutes - offset) * MINUTE_MS;
}
