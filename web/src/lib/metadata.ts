// One date's metadata, loaded and kept current over REST.
//
// The page holds one copy per (location, camera, date), in one query slot,
// with the version (S3 ETag) it is. Every fetch hands that version back, so
// the server can answer with just the rows that changed: the producer
// rewrites metadata.json as each exposure's rows land, and the difference is
// usually one row of a document that can run to megabytes. A WebSocket
// `metadata` message says when to ask again (see liveQuery).

import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { debugLog } from "./debug";
import type { Metadata, MetadataChanges } from "./types";

/** A date's metadata as the page holds it: the rows, and which version. */
export interface MetadataDoc {
  etag: string | null;
  rows: Metadata;
}

export const metadataKey = (loc: string, cam: string, date: string) =>
  ["metadata", loc, cam, date] as const;

// Dates whose metadata.json was rewritten while a fetch of it was in flight.
// That fetch isn't restarted: a whole document over a slow link can take
// longer than the gap between rewrites, and would never finish. It asks
// again when it lands instead, and by then needs only the difference.
const rewrittenMidFetch = new Set<string>();

// A fetch overtaken by rewrite after rewrite stops asking after this many
// more tries and shows what it has; the next rewrite starts another.
const MAX_FOLLOW_UPS = 3;

/** Bring a held document forward by the server's reply. */
export function applyChanges(
  held: MetadataDoc | undefined,
  changes: MetadataChanges,
): MetadataDoc {
  // Unchanged: hand back the same object, so nothing re-renders.
  if (held !== undefined && changes.etag === held.etag) return held;
  // `since: null` marks the whole document, not a difference.
  if (held === undefined || changes.since === null) {
    return { etag: changes.etag, rows: changes.rows };
  }
  const rows = { ...held.rows, ...changes.rows };
  for (const seq of changes.removed) delete rows[seq];
  return { etag: changes.etag, rows };
}

/** The query function for a date's metadata: the held document, brought
 *  current. */
export async function fetchMetadata(
  qc: QueryClient,
  location: string,
  camera: string,
  date: string,
): Promise<MetadataDoc> {
  const key = metadataKey(location, camera, date);
  const id = JSON.stringify(key);
  let doc = qc.getQueryData<MetadataDoc>(key);
  let followUps = 0;
  do {
    rewrittenMidFetch.delete(id);
    const changes = await api.metadataChanges(
      location,
      camera,
      date,
      doc?.etag ?? null,
    );
    doc = applyChanges(doc, changes);
    debugLog("metadata.fetched", {
      camera,
      date,
      whole: changes.since === null,
      rows: Object.keys(changes.rows).length,
      removed: changes.removed.length,
    });
  } while (rewrittenMidFetch.has(id) && followUps++ < MAX_FOLLOW_UPS);
  return doc;
}

/** A date's metadata.json was rewritten: fetch what changed, if any view is
 *  showing it. */
export function metadataRewritten(
  qc: QueryClient,
  location: string,
  camera: string,
  date: string,
): void {
  const queryKey = metadataKey(location, camera, date);
  if (qc.isFetching({ queryKey, exact: true }) > 0) {
    rewrittenMidFetch.add(JSON.stringify(queryKey));
    return;
  }
  void qc.invalidateQueries({ queryKey, exact: true });
}
