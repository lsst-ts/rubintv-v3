import { useQuery, useQueryClient } from "@tanstack/react-query";
import { roughAge, utcClock } from "./lastPoll";
import type { RedisStatus } from "./types";

// Whether the server is reading Redis, and when Redis last answered it.
//
// The Cluster Status and Admin pages show what Redis last said. The cluster
// writes its status only when it changes and a control's readback only when
// it is acknowledged, so a picture that hasn't changed and one that can no
// longer change look the same unless the page says which it has.
//
// The server reports ages (seconds before its answer), and these are placed
// on the tab's own clock, so the two clocks needn't agree (as lastPoll does).

export interface RedisLink {
  // A Redis is configured for this deployment.
  configured: boolean;
  // It is answering the server now.
  connected: boolean;
  // When `connected` last changed; while it is false and Redis has never
  // answered, when the server started trying.
  changedAt: number | null;
  // When Redis last answered the server; null if it never has.
  readAt: number | null;
}

// The cache slot the live messages write the link to.
export const redisLinkKey = () => ["redisLink"] as const;

const at = (receivedAt: number, age: number | null | undefined) =>
  age == null ? null : receivedAt - age * 1000;

/** A server report, heard at `receivedAt`, on this tab's clock. */
export function redisLinkFrom(
  report: RedisStatus | null | undefined,
  receivedAt: number,
): RedisLink | undefined {
  if (!report) return undefined;
  return {
    configured: report.configured,
    connected: report.connected,
    changedAt: at(receivedAt, report.changed_age_seconds),
    readAt: at(receivedAt, report.read_age_seconds),
  };
}

/** When each detector set was written, from the ages a message carried. */
export function writtenTimes(
  ages: Record<string, number> | null | undefined,
  receivedAt: number,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(ages ?? {}).map(([name, age]) => [
      name,
      receivedAt - age * 1000,
    ]),
  );
}

// The link as the live messages last gave it (see applyLiveMessage): the
// server sends it with every detector and readback message, and again
// whenever it changes. Undefined until the first arrives.
export function useRedisLink(): RedisLink | undefined {
  const qc = useQueryClient();
  const key = redisLinkKey();
  const { data } = useQuery<RedisLink | null>({
    queryKey: key,
    queryFn: () => qc.getQueryData<RedisLink>(key) ?? null,
    staleTime: Infinity,
  });
  return data ?? undefined;
}

/** A time for a sentence: the UTC clock time, with its date once that is
 *  no longer today's by any reading (over a day ago). */
export function utcWhen(at: number, now: number): string {
  const clock = `${utcClock(at)} UTC`;
  return now - at < 86_400_000
    ? clock
    : `${new Date(at).toISOString().slice(0, 10)} ${clock}`;
}

/** Since when a link that is down has gone unanswered, to follow "no answer
 *  from Redis": "since 14:02:11 UTC", or "since the server started" for one
 *  that never has been. Fixed while the link stays down, so it can sit in a
 *  live region; the age that grows beside it is `unansweredFor`. */
export function unansweredSince(link: RedisLink, now: number): string {
  return link.readAt === null
    ? "since the server started"
    : `since ${utcWhen(link.readAt, now)}`;
}

/** How long that is, in words; null if the server didn't say. */
export function unansweredFor(link: RedisLink, now: number): string | null {
  const from = link.readAt ?? link.changedAt;
  return from === null ? null : roughAge(now - from);
}
