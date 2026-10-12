import { useSyncExternalStore } from "react";

/**
 * The current time, floored to the minute, from one timer shared by every subscriber. The timer
 * fires on minute boundaries and stops when nothing listens, so the "now" line and past-event
 * muting cost one render per minute.
 */
const listeners = new Set<() => void>();
let now = floorToMinute(Date.now());
let timer: ReturnType<typeof setTimeout> | null = null;

function floorToMinute(ms: number): number {
  return ms - (ms % 60_000);
}

function tick() {
  const current = floorToMinute(Date.now());
  if (current !== now) {
    now = current;
    for (const listener of listeners) listener();
  }
  timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = floorToMinute(Date.now());
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

function snapshot(): number {
  return now;
}

/** Epoch ms of the current minute; re-renders the caller once a minute. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
