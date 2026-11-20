import { useEffect, useState } from "react";
import { useLive } from "../lib/LiveContext";
import {
  roughAge,
  STALE_AFTER_MS,
  useLastPoll,
  useNow,
  utcClock,
} from "../lib/lastPoll";

// "as of HH:MM:SS UTC" beside the current day's date: when the server last
// polled the bucket, so how current the page's data is. Quiet while that is
// recent; amber, with its age, once it isn't, whatever the cause (the poll
// has stalled or can't reach S3, the server is unreachable, or this tab has
// lost its connection).
//
// While the tab is disconnected the time stands at the last one seen before
// it dropped: the server may well be polling still, but nothing it finds is
// reaching this page.
export function DataAsOf() {
  const { disconnected } = useLive();
  const polled = useLastPoll();
  const [asOf, setAsOf] = useState<number | null>(null);
  useEffect(() => {
    if (!disconnected && polled !== null) setAsOf(polled);
  }, [disconnected, polled]);
  const now = useNow();

  if (asOf === null) return null;
  const age = now - asOf;
  const stale = age > STALE_AFTER_MS;
  const at = `${utcClock(asOf)} UTC`;
  // No live region: the time changes every few seconds, and the header's
  // pills announce the states behind a stale one.
  return (
    <span
      className={"data-as-of" + (stale ? " is-stale" : "")}
      title={
        stale
          ? `Nothing newer than ${at} is on this page. The server has not finished a check of the bucket since then, or this tab has lost touch with the server.`
          : `The server last checked the bucket for new data at ${at}. It checks about once a second; the time shown here is refreshed every 5 seconds.`
      }
    >
      as of {at}
      {stale && ` · ${roughAge(age)} ago`}
    </span>
  );
}
