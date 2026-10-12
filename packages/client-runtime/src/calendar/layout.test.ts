import { describe, expect, it } from "vite-plus/test";

import { bucketInstances, sliceSpans, type SpanItem, type TimedSegment } from "./days.ts";
import { layoutDay, layoutDayCached, packLevels } from "./layout.ts";
import { instance, minutes } from "./testFixtures.ts";

function segment(id: string, from: string, to: string): TimedSegment {
  return {
    key: `cal/${id}`,
    instance: instance(id, { start: 0, end: 0 }),
    startMinutes: minutes(from),
    endMinutes: minutes(to),
    continuesBefore: false,
    continuesAfter: false,
  };
}

function span(
  id: string,
  startIndex: number,
  endIndex: number,
  kind: SpanItem["kind"] = "allDay",
): SpanItem {
  return {
    key: `cal/${id}`,
    instance: instance(id, { start: startIndex, end: endIndex + 1, allDay: kind === "allDay" }),
    kind,
    startIndex,
    endIndex,
    continuesBefore: false,
    continuesAfter: false,
  };
}

type Geometry = Record<string, [left: number, width: number]>;

function geometry(segments: TimedSegment[], options?: Parameters<typeof layoutDay>[1]): Geometry {
  return Object.fromEntries(
    layoutDay(segments, options).map((p) => [p.segment.instance.eventId, [p.left, p.width]]),
  );
}

describe("layoutDay", () => {
  it("gives events that do not overlap the full width", () => {
    expect(geometry([segment("a", "09:00", "10:00"), segment("b", "10:00", "11:00")])).toEqual({
      a: [0, 1],
      b: [0, 1],
    });
  });

  it("splits overlapping events into columns and reuses freed columns", () => {
    const placements = layoutDay([
      segment("long", "09:00", "11:00"),
      segment("first", "09:00", "10:00"),
      segment("second", "10:00", "11:00"),
    ]);
    expect(placements.map((p) => [p.segment.instance.eventId, p.column, p.columns])).toEqual([
      ["long", 0, 2],
      ["first", 1, 2],
      ["second", 1, 2],
    ]);
  });

  it("expands events right until the first column with a collider", () => {
    expect(
      geometry([
        segment("a", "09:00", "12:00"),
        segment("b", "09:00", "10:00"),
        segment("c", "09:00", "10:00"),
        segment("d", "10:30", "11:00"),
      ]),
    ).toEqual({
      a: [0, 1 / 3],
      b: [1 / 3, 1 / 3],
      c: [2 / 3, 1 / 3],
      // Column 1 again, and nothing in column 2 overlaps it.
      d: [1 / 3, 2 / 3],
    });
  });

  it("packs short events that look overlapping as overlapping", () => {
    const short = [segment("a", "09:00", "09:05"), segment("b", "09:10", "09:15")];
    expect(geometry(short, { minVisualMinutes: 20 })).toEqual({ a: [0, 0.5], b: [0.5, 0.5] });
    expect(geometry(short, { minVisualMinutes: 5 })).toEqual({ a: [0, 1], b: [0, 1] });
  });

  it("lays out clusters independently", () => {
    const result = geometry([
      segment("a", "09:00", "10:00"),
      segment("b", "09:30", "10:30"),
      segment("c", "10:00", "11:00"),
      segment("lunch", "12:00", "13:00"),
    ]);
    expect(result).toEqual({ a: [0, 0.5], b: [0.5, 0.5], c: [0, 0.5], lunch: [0, 1] });
  });

  it("orders identical events by key, whatever the input order", () => {
    const x = segment("x", "09:00", "10:00");
    const y = segment("y", "09:00", "10:00");
    const forward = layoutDay([x, y]).map((p) => [p.segment.key, p.left]);
    const backward = layoutDay([y, x]).map((p) => [p.segment.key, p.left]);
    expect(forward).toEqual([
      ["cal/x", 0],
      ["cal/y", 0.5],
    ]);
    expect(backward).toEqual(forward);
  });

  it("cascades like Google when asked", () => {
    const result = geometry(
      [
        segment("a", "09:00", "11:00"),
        segment("b", "09:30", "10:00"),
        segment("c", "10:30", "11:30"),
      ],
      { cascade: true },
    );
    expect(result).toEqual({ a: [0, 1], b: [0.5, 0.5], c: [0.5, 0.5] });
  });

  it("memoizes by segment array identity", () => {
    const segments = [segment("a", "09:00", "10:00")];
    const first = layoutDayCached(segments);
    expect(layoutDayCached(segments)).toBe(first);
    expect(layoutDayCached(segments, { minVisualMinutes: 30 })).not.toBe(first);
  });

  it("lays out 100 events a day well under a millisecond", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const segments = Array.from({ length: 100 }, (_, index) => {
      const start = Math.floor(random() * 1380);
      const length = 15 + Math.floor(random() * 120);
      return {
        ...segment(`e${index}`, "00:00", "00:00"),
        startMinutes: start,
        endMinutes: Math.min(1440, start + length),
      };
    });
    for (let warm = 0; warm < 200; warm++) layoutDay(segments);
    const runs = 1000;
    const started = performance.now();
    for (let run = 0; run < runs; run++) layoutDay(segments);
    const perDay = (performance.now() - started) / runs;
    // Typically ~0.02 ms; the bound leaves room for slow CI machines.
    expect(perDay).toBeLessThan(0.5);
    // Every placement stays inside the column, and overlapping events never share space.
    const placements = layoutDay(segments);
    for (const p of placements) {
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.left + p.width).toBeLessThanOrEqual(1 + 1e-9);
    }
    for (const a of placements) {
      for (const b of placements) {
        if (a === b) continue;
        const aEnd = Math.max(a.segment.endMinutes, a.segment.startMinutes + 20);
        const bEnd = Math.max(b.segment.endMinutes, b.segment.startMinutes + 20);
        const overlapInTime = a.segment.startMinutes < bEnd && b.segment.startMinutes < aEnd;
        const overlapInSpace = a.left < b.left + b.width - 1e-9 && b.left < a.left + a.width - 1e-9;
        expect(overlapInTime && overlapInSpace).toBe(false);
      }
    }
  });
});

describe("packLevels", () => {
  it("stacks spans into the lowest free level, longer first", () => {
    const layout = packLevels(
      [span("short", 1, 1), span("long", 1, 3), span("after", 4, 5), span("first", 0, 1)],
      7,
    );
    expect(layout.placements.map((p) => [p.item.instance.eventId, p.level])).toEqual([
      ["first", 0],
      ["long", 1],
      ["short", 2],
      ["after", 0],
    ]);
    expect(layout.rows).toBe(3);
    expect(layout.truncated).toBe(false);
  });

  it("puts all-day events before timed ones of the same length", () => {
    const layout = packLevels([span("timed", 2, 2, "timed"), span("allday", 2, 2)], 7);
    expect(layout.placements.map((p) => p.item.instance.eventId)).toEqual(["allday", "timed"]);
  });

  it("keeps the last row for +N more and counts hidden items per day", () => {
    const items = [
      span("a", 0, 0),
      span("b", 0, 0),
      span("c", 0, 0),
      span("d", 0, 0),
      span("x", 1, 1),
      span("y", 1, 1),
      span("z", 1, 1),
    ];
    const layout = packLevels(items, 7, 3);
    expect(layout.rows).toBe(3);
    expect(layout.truncated).toBe(true);
    expect(layout.hiddenPerDay.slice(0, 2)).toEqual([2, 0]);
    // Day 1's third item is its only overflow, so it shows instead of "+1 more".
    expect(layout.placements.map((p) => [p.item.instance.eventId, p.level])).toEqual([
      ["a", 0],
      ["b", 1],
      ["x", 0],
      ["y", 1],
      ["z", 2],
    ]);
  });

  it("hides a multi-day span only where it overflows", () => {
    const layout = packLevels(
      [span("a", 0, 0), span("b", 0, 0), span("wide", 0, 3), span("c", 2, 2)],
      7,
      2,
    );
    // Day 0 overflows by two; day 2's lone overflow takes the last row.
    expect(layout.placements.map((p) => [p.item.instance.eventId, p.level])).toEqual([
      ["wide", 0],
      ["c", 1],
    ]);
    expect(layout.hiddenPerDay.slice(0, 4)).toEqual([2, 0, 0, 0]);
  });

  it("shows everything when it fits", () => {
    const layout = packLevels([span("a", 0, 0), span("b", 0, 0)], 7, 2);
    expect(layout.truncated).toBe(false);
    expect(layout.placements).toHaveLength(2);
  });
});

describe("view-sized workloads", () => {
  function randomInstances(count: number, firstDay: number, days: number) {
    let seed = 11;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    return Array.from({ length: count }, (_, index) => {
      const day = firstDay + Math.floor(random() * days);
      if (random() < 0.1) {
        const length = 1 + Math.floor(random() * 4);
        return instance(`e${index}`, {
          start: day * 86_400_000,
          end: (day + length) * 86_400_000,
          allDay: true,
        });
      }
      const start = day * 86_400_000 + Math.floor(random() * 1380) * 60_000;
      return instance(`e${index}`, {
        start,
        end: start + (15 + Math.floor(random() * 150)) * 60_000,
      });
    });
  }

  function timeIt(run: () => void): number {
    for (let warm = 0; warm < 5; warm++) run();
    const runs = 20;
    const started = performance.now();
    for (let index = 0; index < runs; index++) run();
    return (performance.now() - started) / runs;
  }

  it("buckets and lays out a 500-event week and a 3000-event month within a frame", () => {
    const monday = 20_724; // 2026-09-28
    const week = Array.from({ length: 7 }, (_, index) => monday + index);
    const weekEvents = randomInstances(500, monday, 7);
    const weekMs = timeIt(() => {
      const buckets = bucketInstances(weekEvents, week, "Europe/Berlin");
      for (const segments of buckets.timed) layoutDay(segments);
      packLevels(buckets.spans, 7, 3);
    });

    const month = Array.from({ length: 42 }, (_, index) => monday - 28 + index);
    const monthEvents = randomInstances(3000, month[0]!, 42);
    const monthMs = timeIt(() => {
      const buckets = bucketInstances(monthEvents, month, "Europe/Berlin");
      for (let row = 0; row < 6; row++) {
        const items = sliceSpans(buckets.spans, row * 7, row * 7 + 7);
        for (let index = row * 7; index < row * 7 + 7; index++) {
          for (const segment of buckets.timed[index]!) {
            items.push({
              ...span(segment.key, index - row * 7, index - row * 7, "timed"),
              instance: segment.instance,
            });
          }
        }
        packLevels(items, 7, 4);
      }
    });
    // Typically ~0.5 ms and ~3 ms (bucketing ~1.7 ms, packing ~0.6 ms); bounds leave room for CI.
    expect(weekMs).toBeLessThan(16);
    expect(monthMs).toBeLessThan(40);
  });
});
