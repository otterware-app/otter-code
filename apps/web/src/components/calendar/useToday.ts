import { type DayNumber, endOfZonedDay, zonedDay } from "@t3tools/shared/calendar/time";
import { useEffect, useState } from "react";

function now(): number {
  return Date.now();
}

/** Today in `timeZone`, updated at local midnight and when the window comes back. */
export function useToday(timeZone: string): DayNumber {
  const [today, setToday] = useState(() => zonedDay(now(), timeZone));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const day = zonedDay(now(), timeZone);
      setToday(day);
      if (timer !== undefined) clearTimeout(timer);
      // Browsers cap long timeouts; re-check at least hourly.
      timer = setTimeout(update, Math.min(endOfZonedDay(day, timeZone) - now() + 1_000, 3_600_000));
    };
    update();
    const onVisible = () => {
      if (document.visibilityState === "visible") update();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [timeZone]);
  return today;
}
