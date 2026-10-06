/**
 * Event layout for calendar views, without measuring the DOM.
 *
 * - `layoutDay` packs one day column's timed segments into side-by-side columns (Google
 *   Calendar style): sort, split into clusters of transitively overlapping events, give each
 *   event the lowest free column, then widen it rightwards through columns it does not collide
 *   with. Output is fractions of the column width; vertical position stays in minutes, so a
 *   renderer can place blocks with CSS and zoom by changing one variable.
 * - `packLevels` stacks day-index spans (all-day lane, month week rows) into levels, and
 *   counts what does not fit under `maxLevels` for "+N more".
 *
 * Both are pure and cheap (well under 0.1 ms for 100 events a day); memoize per day or row by
 * input identity (`layoutDayCached` does this for day columns).
 *
 * @module calendar/layout
 */
import { compareSpans, type SpanItem, type TimedSegment } from "./days.ts";

// ── Timed columns ────────────────────────────────────────────────────

export interface TimedPlacement {
  readonly segment: TimedSegment;
  /** Column within the event's cluster, 0-based. */
  readonly column: number;
  /** Number of columns in the cluster. */
  readonly columns: number;
  /** Columns covered after expanding right, at least 1. */
  readonly span: number;
  /** Left edge as a fraction of the day column's width, 0–1. */
  readonly left: number;
  /** Width as a fraction of the day column's width, 0–1. */
  readonly width: number;
  /** Stacking order; later columns sit on top. */
  readonly zIndex: number;
}

export interface TimedLayoutOptions {
  /**
   * Events shorter than this are packed as if they lasted this long, so blocks that look
   * overlapping (a short block drawn at its minimum height) are laid out as overlapping.
   * Defaults to 20.
   */
  readonly minVisualMinutes?: number;
  /**
   * Google's cascade: events with a collider to their right grow to twice their width
   * (capped at the column edge) and later columns overlap them. Defaults to false.
   */
  readonly cascade?: boolean;
}

/** Lays out one day's timed segments. The output is sorted by start, longer first, then key. */
export function layoutDay(
  segments: ReadonlyArray<TimedSegment>,
  options: TimedLayoutOptions = {},
): TimedPlacement[] {
  const count = segments.length;
  if (count === 0) return [];
  const minVisual = options.minVisualMinutes ?? 20;
  const cascade = options.cascade ?? false;

  const starts = new Float64Array(count);
  const ends = new Float64Array(count);
  const order: number[] = [];
  for (let index = 0; index < count; index++) {
    const segment = segments[index]!;
    starts[index] = segment.startMinutes;
    ends[index] = Math.max(segment.endMinutes, segment.startMinutes + minVisual);
    order.push(index);
  }
  order.sort((a, b) => {
    const byStart = starts[a]! - starts[b]!;
    if (byStart !== 0) return byStart;
    const byEnd = ends[b]! - ends[a]!;
    if (byEnd !== 0) return byEnd;
    const keyA = segments[a]!.key;
    const keyB = segments[b]!.key;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  const placements: TimedPlacement[] = [];
  const columnOf = new Int32Array(count);
  // Per column of the current cluster: its events (sorted, non-overlapping) and its last end.
  let columnEvents: number[][] = [];
  let columnEnds: number[] = [];
  let clusterFrom = 0;
  let clusterEnd = -Infinity;

  const finishCluster = (to: number) => {
    const columns = columnEvents.length;
    for (let position = clusterFrom; position < to; position++) {
      const index = order[position]!;
      const column = columnOf[index]!;
      let span = columns;
      for (let next = column + 1; next < columns; next++) {
        if (collides(columnEvents[next]!, starts, ends, starts[index]!, ends[index]!)) {
          span = next;
          break;
        }
      }
      const left = column / columns;
      let width = (span - column) / columns;
      if (cascade) width = Math.min(1 - left, width * 2);
      placements.push({
        segment: segments[index]!,
        column,
        columns,
        span: span - column,
        left,
        width,
        zIndex: column + 1,
      });
    }
  };

  for (let position = 0; position < count; position++) {
    const index = order[position]!;
    const start = starts[index]!;
    if (start >= clusterEnd && position > 0) {
      finishCluster(position);
      columnEvents = [];
      columnEnds = [];
      clusterFrom = position;
      clusterEnd = -Infinity;
    }
    let column = 0;
    while (column < columnEnds.length && columnEnds[column]! > start) column++;
    if (column === columnEnds.length) {
      columnEnds.push(0);
      columnEvents.push([]);
    }
    columnEnds[column] = ends[index]!;
    columnEvents[column]!.push(index);
    columnOf[index] = column;
    if (ends[index]! > clusterEnd) clusterEnd = ends[index]!;
  }
  finishCluster(count);
  return placements;
}

/** Whether any event of a column (sorted by start, non-overlapping) intersects [start, end). */
function collides(
  events: ReadonlyArray<number>,
  starts: Float64Array,
  ends: Float64Array,
  start: number,
  end: number,
): boolean {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ends[events[mid]!]! <= start) low = mid + 1;
    else high = mid;
  }
  return low < events.length && starts[events[low]!]! < end;
}

const dayLayoutCache = new WeakMap<
  ReadonlyArray<TimedSegment>,
  { readonly minVisual: number; readonly cascade: boolean; readonly result: TimedPlacement[] }
>();

/** `layoutDay`, memoized by the identity of the segment array. */
export function layoutDayCached(
  segments: ReadonlyArray<TimedSegment>,
  options: TimedLayoutOptions = {},
): ReadonlyArray<TimedPlacement> {
  const minVisual = options.minVisualMinutes ?? 20;
  const cascade = options.cascade ?? false;
  const cached = dayLayoutCache.get(segments);
  if (cached !== undefined && cached.minVisual === minVisual && cached.cascade === cascade) {
    return cached.result;
  }
  const result = layoutDay(segments, { minVisualMinutes: minVisual, cascade });
  dayLayoutCache.set(segments, { minVisual, cascade, result });
  return result;
}

// ── Levels (all-day lane, month rows) ────────────────────────────────

export interface LevelPlacement {
  readonly item: SpanItem;
  /** Row within the lane or week row, 0-based. */
  readonly level: number;
}

export interface LevelLayout {
  /** Items shown, sorted by `compareSpans`. */
  readonly placements: ReadonlyArray<LevelPlacement>;
  /** Items not shown, per day index (for "+N more"). */
  readonly hiddenPerDay: ReadonlyArray<number>;
  /** Whether any day has hidden items. */
  readonly truncated: boolean;
  /**
   * Rows the lane needs: the used levels, or `maxLevels` when truncated (the last row then
   * holds the "+N more" links, at level `rows - 1`).
   */
  readonly rows: number;
  /** Levels needed to show everything. */
  readonly totalLevels: number;
}

/**
 * Packs spans into the lowest level where they fit (FullCalendar's `buildSegLevels`), for a
 * lane of `dayCount` days. With `maxLevels`, the last visible row is kept for "+N more" when
 * anything overflows; an item that would be a day's only hidden one is shown there instead.
 */
export function packLevels(
  items: ReadonlyArray<SpanItem>,
  dayCount: number,
  maxLevels = Number.POSITIVE_INFINITY,
): LevelLayout {
  const sorted = [...items].sort(compareSpans);
  const levelEnds: number[] = [];
  const levels = new Int32Array(sorted.length);
  sorted.forEach((item, index) => {
    let level = 0;
    while (level < levelEnds.length && levelEnds[level]! >= item.startIndex) level++;
    levelEnds[level] = item.endIndex;
    levels[index] = level;
  });
  const totalLevels = levelEnds.length;
  const hiddenPerDay = Array.from<number>({ length: dayCount }).fill(0);

  if (totalLevels <= maxLevels) {
    return {
      placements: sorted.map((item, index) => ({ item, level: levels[index]! })),
      hiddenPerDay,
      truncated: false,
      rows: totalLevels,
      totalLevels,
    };
  }

  const limit = Math.max(0, Math.floor(maxLevels) - 1);
  const hidden: number[] = [];
  sorted.forEach((item, index) => {
    if (levels[index]! < limit) return;
    hidden.push(index);
    for (let day = item.startIndex; day <= item.endIndex && day < dayCount; day++) {
      hiddenPerDay[day]!++;
    }
  });
  // A day's only hidden item takes the "+N more" row instead of a "+1 more" link.
  const revealed = new Set<number>();
  if (maxLevels >= 1) {
    for (const index of hidden) {
      const item = sorted[index]!;
      let alone = true;
      for (let day = item.startIndex; day <= item.endIndex && day < dayCount; day++) {
        if (hiddenPerDay[day] !== 1) {
          alone = false;
          break;
        }
      }
      if (!alone) continue;
      revealed.add(index);
      for (let day = item.startIndex; day <= item.endIndex && day < dayCount; day++) {
        hiddenPerDay[day] = 0;
      }
    }
  }
  const placements: LevelPlacement[] = [];
  sorted.forEach((item, index) => {
    if (levels[index]! < limit) placements.push({ item, level: levels[index]! });
    else if (revealed.has(index)) placements.push({ item, level: limit });
  });
  return {
    placements,
    hiddenPerDay,
    truncated: hiddenPerDay.some((count) => count > 0),
    rows: Math.min(totalLevels, Math.max(0, Math.floor(maxLevels))),
    totalLevels,
  };
}
