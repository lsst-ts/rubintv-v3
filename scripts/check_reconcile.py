#!/usr/bin/env python3
"""Validate index reconciliation against a real S3 listing, read-only.

Reconciliation is what deletes indexed data: it takes an S3 listing, treats
it as authoritative for its scope, and drops anything indexed but absent.
That makes a wrong listing (truncated pagination, a mis-scoped prefix) a
silent data-loss bug. The unit tests exercise it against moto and fakes,
which can't tell you whether *real* key shapes parse the way the index
expects.

This script closes that gap without touching the bucket or the running app:

1. List one or more real camera prefixes (``list_objects_v2``, read-only).
2. Build an index from that listing, exactly as the poller + store would.
3. Reconcile the index against the same listing.

A listing reconciled against itself must be a no-op. Anything dropped means
the ingest path and the reconcile path disagree about what a key means —
i.e. reconciliation would delete live data in production. That is the whole
check, and it needs no mutation to perform.

With ``--expect-stable-across-scans`` it lists twice and reports keys that
appeared or vanished between them, which distinguishes a genuine upstream
change from a listing that is non-deterministic (the failure mode that
would make reconciliation flap).

Usage (from a USDF-resident host, or through an S3 tunnel)::

    python scripts/check_reconcile.py \
        --endpoint-url https://sdfembs3.sdf.slac.stanford.edu \
        --bucket rubin-rubintv-data-usdf \
        --prefix auxtel/ --prefix allsky/

Exit status is 0 when reconciliation is a clean no-op, 1 otherwise.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

import boto3
from botocore.config import Config

# Import the real app code, so this validates what actually ships.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from lsst.ts.rubintv.data.events import ObjectEvent, ObjectKind  # noqa: E402
from lsst.ts.rubintv.data.store import EventStore, ScanScope  # noqa: E402

LOCATION = "check"


def list_prefix(client: object, bucket: str, prefix: str) -> set[str]:
    """Page a whole prefix into a key set (the poller's ``_list``)."""
    paginator = client.get_paginator("list_objects_v2")  # type: ignore[attr-defined]
    keys: set[str] = set()
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            keys.add(obj["Key"])
    return keys


async def check_prefix(
    client: object, bucket: str, prefix: str, *, twice: bool
) -> bool:
    """Ingest a real listing, reconcile against it, and report any drift."""
    print(f"\n=== {prefix} ===")
    keys = list_prefix(client, bucket, prefix)
    print(f"  listed:          {len(keys)} objects")
    if not keys:
        print("  SKIP: prefix is empty")
        return True

    # Ingest exactly as the poller + store would.
    store = EventStore()
    events = [
        ObjectEvent(kind=ObjectKind.CREATED, location=LOCATION, key=key)
        for key in sorted(keys)
    ]
    await store.apply(events)

    camera = prefix.split("/")[0]
    snapshot = store.snapshot().get((LOCATION, camera), {})
    indexed_dates = len(snapshot)
    indexed_seqs = sum(
        len(s) for idx in snapshot.values() for s in idx.channels.values()
    )
    unparsed = len(keys) - _countable(snapshot)
    print(f"  indexed:         {indexed_dates} dates, {indexed_seqs} seqs")
    print(f"  not indexed:     {unparsed} keys (metadata.json, non-conforming)")

    # The core assertion: reconciling a listing against itself changes nothing.
    dropped = await store.reconcile((LOCATION, camera), keys, ScanScope())
    after = store.snapshot().get((LOCATION, camera), {})
    after_seqs = sum(len(s) for idx in after.values() for s in idx.channels.values())

    ok = not dropped and after_seqs == indexed_seqs and len(after) == indexed_dates
    if ok:
        print("  self-reconcile:  OK (no-op, as required)")
    else:
        print("  self-reconcile:  FAILED — would delete live data:")
        print(f"    dates dropped: {sorted(dropped)}")
        print(f"    seqs: {indexed_seqs} -> {after_seqs}")
        print(f"    dates: {indexed_dates} -> {len(after)}")

    if twice:
        again = list_prefix(client, bucket, prefix)
        appeared, vanished = again - keys, keys - again
        if not appeared and not vanished:
            print("  listing stable:  OK (identical across two scans)")
        else:
            # Not necessarily a bug — data may genuinely have landed — but
            # vanished keys during a quiet period suggest listing instability.
            print(
                f"  listing drift:   +{len(appeared)} / -{len(vanished)} "
                "(expected only if data is actively being written)"
            )
            for key in sorted(vanished)[:5]:
                print(f"    vanished: {key}")
    return ok


def _countable(snapshot: dict) -> int:
    """Object keys the index accounts for, to size the 'not indexed' figure."""
    total = 0
    for idx in snapshot.values():
        total += sum(len(s) for s in idx.channels.values())
        total += len(idx.per_day)
        total += len(idx.night_report_keys)
    return total


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--endpoint-url", required=True)
    ap.add_argument("--bucket", required=True)
    ap.add_argument(
        "--prefix",
        action="append",
        required=True,
        help="camera prefix, e.g. 'auxtel/' (repeatable)",
    )
    ap.add_argument("--profile", default=None, help="AWS profile name")
    ap.add_argument(
        "--expect-stable-across-scans",
        action="store_true",
        help="list each prefix twice and report keys that changed between",
    )
    args = ap.parse_args()

    session = (
        boto3.Session(profile_name=args.profile) if args.profile else boto3.Session()
    )
    client = session.client(
        "s3",
        endpoint_url=args.endpoint_url,
        config=Config(retries={"max_attempts": 3, "mode": "standard"}),
    )

    print(f"bucket:   {args.bucket}")
    print(f"endpoint: {args.endpoint_url}")
    print("READ-ONLY: this script never writes to or deletes from the bucket.")

    results = [
        await check_prefix(
            client, args.bucket, prefix, twice=args.expect_stable_across_scans
        )
        for prefix in args.prefix
    ]

    print()
    if all(results):
        print("PASS: reconciliation is a clean no-op on every prefix.")
        return 0
    print("FAIL: reconciliation would delete live data. Do NOT deploy.")
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
