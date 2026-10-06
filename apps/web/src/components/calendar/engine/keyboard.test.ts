import type { CalendarEventInstance } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { NudgeBatch, type PendingNudge } from "./keyboard";

const instance = {
  calendarId: "cal" as CalendarEventInstance["calendarId"],
  eventId: "a",
  title: "A",
  start: 0,
  end: 1_800_000,
} satisfies CalendarEventInstance;

function nudge(key: string, start: number): PendingNudge {
  return { key, instance, result: { start, end: start + 1_800_000, allDay: false } };
}

describe("NudgeBatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function batch() {
    const shown: number[] = [];
    const committed: PendingNudge[] = [];
    let hidden = 0;
    const nudges = new NudgeBatch({
      delay: 400,
      show: (pending) => shown.push(pending.result.start),
      hide: () => hidden++,
      commit: (pending) => committed.push(pending),
    });
    return { nudges, shown, committed, hidden: () => hidden };
  }

  it("shows every press and commits once after the pause", () => {
    const { nudges, shown, committed } = batch();
    nudges.update(nudge("a", 900_000));
    vi.advanceTimersByTime(300);
    expect(nudges.current("a")?.start).toBe(900_000);
    nudges.update(nudge("a", 1_800_000));
    vi.advanceTimersByTime(300);
    nudges.update(nudge("a", 2_700_000));
    expect(committed).toHaveLength(0);
    vi.advanceTimersByTime(400);
    expect(shown).toEqual([900_000, 1_800_000, 2_700_000]);
    expect(committed.map((pending) => pending.result.start)).toEqual([2_700_000]);
    expect(nudges.current("a")).toBeNull();
  });

  it("commits the previous event when another one is nudged, and cancels on request", () => {
    const { nudges, committed, hidden } = batch();
    nudges.update(nudge("a", 900_000));
    nudges.update(nudge("b", 900_000));
    expect(committed.map((pending) => pending.key)).toEqual(["a"]);
    expect(nudges.cancel()).toBe(true);
    expect(hidden()).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(committed).toHaveLength(1);
    expect(nudges.cancel()).toBe(false);
  });
});
