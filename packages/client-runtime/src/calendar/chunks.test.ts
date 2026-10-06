import { describe, expect, it } from "vite-plus/test";
import { endOfZonedDay, startOfZonedDay } from "@t3tools/shared/calendar/time";

import { chunkKey, chunkRange, chunkWeeksForDays, neighbourChunkWeeks } from "./chunks.ts";
import { day } from "./testFixtures.ts";

const DAY = 86_400_000;

describe("week chunks", () => {
  it("keys chunks by their UTC Monday", () => {
    expect(chunkKey(day("2026-09-30"))).toBe("2026-09-28");
    expect(chunkKey(day("2026-09-28"))).toBe("2026-09-28");
    expect(chunkKey(day("2026-10-04"))).toBe("2026-09-28");
    expect(chunkKey(day("1969-12-31"))).toBe("1969-12-29");
    expect(chunkRange("2026-09-28")).toEqual({
      start: Date.UTC(2026, 8, 28),
      end: Date.UTC(2026, 9, 5),
    });
    expect(chunkRange("nope")).toBeNull();
  });

  it("covers a local week with the chunks its zone needs", () => {
    const monday = day("2026-09-28");
    const sunday = day("2026-10-04");
    expect(chunkWeeksForDays(monday, sunday, "UTC")).toEqual(["2026-09-28"]);
    // East of UTC, local Monday starts on Sunday in UTC.
    expect(chunkWeeksForDays(monday, sunday, "Europe/Berlin")).toEqual([
      "2026-09-21",
      "2026-09-28",
    ]);
    // West of UTC, local Sunday ends on Monday in UTC.
    expect(chunkWeeksForDays(monday, sunday, "America/New_York")).toEqual([
      "2026-09-28",
      "2026-10-05",
    ]);
    // Without a zone: the contract's padding by a day on each side.
    expect(chunkWeeksForDays(monday, sunday)).toEqual(["2026-09-21", "2026-09-28", "2026-10-05"]);
  });

  it("covers every instant and all-day date of the view in extreme zones", () => {
    const zones = [
      "Pacific/Kiritimati", // +14
      "Etc/GMT+12", // -12
      "Pacific/Chatham", // +12:45 / +13:45
      "America/St_Johns", // -3:30
      "Europe/Berlin",
      "America/New_York",
      "Asia/Kolkata",
    ];
    const base = day("2026-03-02");
    for (const zone of zones) {
      for (let offset = 0; offset < 280; offset += 3) {
        for (const length of [1, 4, 7, 42]) {
          const first = base + offset;
          const last = first + length - 1;
          const weeks = chunkWeeksForDays(first, last, zone);
          const ranges = weeks.map((week) => chunkRange(week)!);
          const covered = (ms: number) => ranges.some((r) => r.start <= ms && ms < r.end);
          expect(covered(startOfZonedDay(first, zone))).toBe(true);
          expect(covered(endOfZonedDay(last, zone) - 1)).toBe(true);
          expect(covered(first * DAY)).toBe(true);
          expect(covered((last + 1) * DAY - 1)).toBe(true);
          // Contiguous, ascending, and never more than the padded cover.
          ranges.forEach((range, index) => {
            if (index > 0) expect(range.start).toBe(ranges[index - 1]!.end);
          });
          const padded = chunkWeeksForDays(first, last);
          expect(weeks.every((week) => padded.includes(week))).toBe(true);
        }
      }
    }
  });

  it("lists neighbours for prefetching", () => {
    expect(neighbourChunkWeeks(["2026-09-28", "2026-09-21"])).toEqual({
      before: ["2026-09-14"],
      after: ["2026-10-05"],
    });
    expect(neighbourChunkWeeks(["2026-09-28"], 2)).toEqual({
      before: ["2026-09-14", "2026-09-21"],
      after: ["2026-10-05", "2026-10-12"],
    });
    expect(neighbourChunkWeeks([])).toEqual({ before: [], after: [] });
  });
});
