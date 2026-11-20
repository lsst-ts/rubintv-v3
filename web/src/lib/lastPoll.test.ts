import { roughAge, utcClock } from "./lastPoll";

test("utcClock is HH:MM:SS in UTC, zero-padded", () => {
  expect(utcClock(Date.UTC(2026, 10, 20, 4, 5, 6))).toBe("04:05:06");
});

test("roughAge counts seconds, then minutes, then hours", () => {
  expect(roughAge(-5)).toBe("0 s");
  expect(roughAge(45_000)).toBe("45 s");
  expect(roughAge(89_400)).toBe("89 s");
  expect(roughAge(90_000)).toBe("1 min");
  expect(roughAge(12 * 60_000)).toBe("12 min");
  expect(roughAge(90 * 60_000)).toBe("1 h");
  expect(roughAge(5 * 3_600_000)).toBe("5 h");
});
