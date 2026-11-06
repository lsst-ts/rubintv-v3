import { describe, expect, test } from "vitest";
import { currentDayObs, staleTimeForDate } from "./queryClient";

// The observing day rolls at noon UTC (mirrors the server's
// rubintv/data/dayobs.py). These pin the boundary so the client and server
// can't drift.
describe("currentDayObs", () => {
  test("just before noon UTC is still the previous observing day", () => {
    expect(currentDayObs(new Date("2026-06-26T11:59:00Z"))).toBe("2026-06-25");
  });

  test("at noon UTC the observing day rolls over", () => {
    expect(currentDayObs(new Date("2026-06-26T12:00:00Z"))).toBe("2026-06-26");
  });

  test("evening UTC stays on the rolled-over day", () => {
    expect(currentDayObs(new Date("2026-06-26T23:30:00Z"))).toBe("2026-06-26");
  });

  test("just after midnight UTC is still that observing day", () => {
    expect(currentDayObs(new Date("2026-06-27T00:30:00Z"))).toBe("2026-06-26");
  });
});

// staleTime is keyed by how many OBSERVING-days ago the date is; the boundary
// must line up with day_obs (noon-UTC), not calendar-UTC midnight.
describe("staleTimeForDate", () => {
  const dayObsDate = (s: string) => new Date(s); // YYYY-MM-DD -> UTC midnight

  test("the live day_obs is treated as today across the whole night", () => {
    // At 03:00Z the current day_obs is the previous calendar date; that date
    // must still be the WebSocket-driven "today" tier (0), not "yesterday".
    const now = new Date("2026-04-10T03:00:00Z");
    expect(currentDayObs(now)).toBe("2026-04-09");
    expect(staleTimeForDate(dayObsDate("2026-04-09"), now)).toBe(0);
  });

  test("the day before the live day_obs is the yesterday tier", () => {
    const now = new Date("2026-04-10T03:00:00Z"); // day_obs 2026-04-09
    expect(staleTimeForDate(dayObsDate("2026-04-08"), now)).toBe(30 * 1000);
  });

  test("evening-UTC live day_obs is also today", () => {
    const now = new Date("2026-04-10T23:00:00Z"); // day_obs 2026-04-10
    expect(staleTimeForDate(dayObsDate("2026-04-10"), now)).toBe(0);
  });

  test("older dates fall into the week / long tiers", () => {
    const now = new Date("2026-04-10T23:00:00Z"); // day_obs 2026-04-10
    expect(staleTimeForDate(dayObsDate("2026-04-06"), now)).toBe(2 * 60 * 1000);
    expect(staleTimeForDate(dayObsDate("2026-03-01"), now)).toBe(5 * 60 * 1000);
  });
});
