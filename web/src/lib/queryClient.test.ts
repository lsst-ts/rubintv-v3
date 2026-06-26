import { describe, expect, test } from "vitest";
import { currentDayObs } from "./queryClient";

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
