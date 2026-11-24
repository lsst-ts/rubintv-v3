import {
  redisLinkFrom,
  unansweredFor,
  unansweredSince,
  utcWhen,
  writtenTimes,
} from "./redisLink";

const NOW = Date.UTC(2026, 10, 24, 14, 5, 0);

test("a server report is placed on the tab's clock from when it was heard", () => {
  expect(
    redisLinkFrom(
      {
        configured: true,
        connected: false,
        changed_age_seconds: 30,
        read_age_seconds: 45.5,
      },
      NOW,
    ),
  ).toEqual({
    configured: true,
    connected: false,
    changedAt: NOW - 30_000,
    readAt: NOW - 45_500,
  });
  // Nothing reported (an older server): nothing known.
  expect(redisLinkFrom(undefined, NOW)).toBeUndefined();
  expect(redisLinkFrom(null, NOW)).toBeUndefined();
});

test("set ages become times, and none reported is none known", () => {
  expect(writtenTimes({ sfmSet0: 60 }, NOW)).toEqual({ sfmSet0: NOW - 60_000 });
  expect(writtenTimes(undefined, NOW)).toEqual({});
  expect(writtenTimes(null, NOW)).toEqual({});
});

test("utcWhen adds the date once the time is over a day old", () => {
  expect(utcWhen(NOW - 3_600_000, NOW)).toBe("13:05:00 UTC");
  expect(utcWhen(NOW - 86_400_000 + 1, NOW)).toBe("14:05:00 UTC");
  expect(utcWhen(NOW - 86_400_000, NOW)).toBe("2026-11-23 14:05:00 UTC");
});

test("a link that is down says since when, and for how long", () => {
  const down = {
    configured: true,
    connected: false,
    changedAt: NOW - 50_000,
    readAt: NOW - 60_000,
  };
  expect(unansweredSince(down, NOW)).toBe("since 14:04:00 UTC");
  expect(unansweredFor(down, NOW)).toBe("60 s");

  // Never answered: counted from when the server began trying.
  const never = { ...down, readAt: null };
  expect(unansweredSince(never, NOW)).toBe("since the server started");
  expect(unansweredFor(never, NOW)).toBe("50 s");

  // And with no time for that either, no age is claimed.
  expect(unansweredFor({ ...never, changedAt: null }, NOW)).toBeNull();

  // Nor is one of no seconds: it starts counting at the first.
  expect(unansweredFor({ ...down, readAt: NOW - 400 }, NOW)).toBeNull();
  expect(unansweredFor({ ...down, readAt: NOW - 1_000 }, NOW)).toBe("1 s");
});
