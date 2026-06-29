#!/usr/bin/env python3
"""Benchmark S3 polling strategies against a live RubinTV-style bucket.

Self-contained: only stdlib + boto3 (already on the LSST stack). Intended
to run on a USDF-resident host (sdfianaNN), reading live production
buckets read-only, so we can compare polling shapes without involving
the FastAPI app.

What it measures
----------------
For a chosen (profile, endpoint, bucket, list of prefixes), each strategy
runs ``--samples`` times; per-call wall-clock latencies are collected and
summarised (min / p50 / p95 / max / mean).

Strategies
----------
- ``serial-shared``: list each prefix one after the other on a single
  shared boto3 client.
- ``serial-per-prefix``: same shape, but a fresh boto3 client per prefix
  (one new session/client each call) to isolate HTTP-pool effects.
- ``parallel-N-shared``: list all prefixes concurrently using ``N``
  worker threads sharing one boto3 client.
- ``parallel-N-per-prefix``: same parallelism, but each worker has its
  own boto3 client.
- ``head-during-list``: a baseline ``head_object`` (e.g. for
  ``metadata.json``) issued while a ``list_objects_v2`` is running,
  measuring how the listing starves the head. Once with a shared client,
  once with a separate client.
- ``raw vs paginator``: compare ``client.get_paginator`` against a hand
  ``ContinuationToken`` loop.

Output
------
Plain text table to stdout — one row per strategy with min/p50/p95/max
ms.

Safety
------
Read-only: only ``list_objects_v2`` and ``head_object`` are issued.

Usage
-----
::

    bench_s3_poll.py \\
        --profile rubin-rubintv-data-usdf-embargo \\
        --endpoint https://sdfembs3.sdf.slac.stanford.edu \\
        --bucket rubin-rubintv-data-usdf \\
        --prefix lsstcam/2026-05-28/ \\
        --prefix lsstcam_aos/2026-05-28/ \\
        --head-key lsstcam/2026-05-28/metadata.json \\
        --samples 10 \\
        --parallel 1 2 4 8
"""

from __future__ import annotations

import argparse
import statistics
import sys
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import boto3
from botocore.config import Config

# --- client construction --------------------------------------------------


def make_client(profile: str | None, endpoint: str | None) -> object:
    """Build one boto3 S3 client. Same shape as the app's client pool."""
    session = boto3.session.Session(profile_name=profile)
    return session.client(
        "s3",
        endpoint_url=endpoint,
        config=Config(
            retries={"max_attempts": 3, "mode": "standard"},
            max_pool_connections=32,
        ),
    )


# --- single operations ----------------------------------------------------


def list_prefix_paginator(client: object, bucket: str, prefix: str) -> int:
    """List a prefix via the boto3 paginator. Returns object count."""
    paginator = client.get_paginator("list_objects_v2")  # type: ignore[attr-defined]
    count = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        count += len(page.get("Contents", []))
    return count


def list_prefix_raw(client: object, bucket: str, prefix: str) -> int:
    """List a prefix via a manual ContinuationToken loop."""
    count = 0
    kwargs: dict[str, str] = {"Bucket": bucket, "Prefix": prefix}
    while True:
        resp = client.list_objects_v2(**kwargs)  # type: ignore[attr-defined]
        count += len(resp.get("Contents", []))
        token = resp.get("NextContinuationToken")
        if not token:
            break
        kwargs["ContinuationToken"] = token
    return count


def head_one(client: object, bucket: str, key: str) -> bool:
    """One HEAD against ``key``. Returns True iff the object exists."""
    try:
        client.head_object(Bucket=bucket, Key=key)  # type: ignore[attr-defined]
        return True
    except Exception:  # noqa: BLE001 - measurement code, swallow & record miss
        return False


# --- timing helpers -------------------------------------------------------


@dataclass
class Sample:
    """One timed call within a strategy run."""

    label: str
    seconds: float
    detail: str = ""


@dataclass
class StrategyResult:
    """Aggregated timings for one strategy across all samples.

    ``per_call`` measures individual list/HEAD calls (apples-to-apples
    across strategies). ``per_cycle`` measures the wall-clock of one
    full pass over all prefixes — this is what the user actually waits
    on for the next poll-cycle's data, and it's where parallelism shows
    up. Strategies that don't have a meaningful 'cycle' (e.g.
    head-during-list) leave ``per_cycle`` empty.
    """

    name: str
    per_call: list[Sample] = field(default_factory=list)
    per_cycle: list[float] = field(default_factory=list)

    @staticmethod
    def _percentile(values: list[float], p: float) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        idx = max(0, min(len(ordered) - 1, int(round(p / 100 * (len(ordered) - 1)))))
        return ordered[idx]

    def call_stats(self) -> tuple[int, float, float, float, float, float]:
        secs = [s.seconds for s in self.per_call]
        if not secs:
            return (0, 0.0, 0.0, 0.0, 0.0, 0.0)
        return (
            len(secs),
            min(secs) * 1000,
            self._percentile(secs, 50) * 1000,
            self._percentile(secs, 95) * 1000,
            max(secs) * 1000,
            statistics.fmean(secs) * 1000,
        )

    def cycle_stats(self) -> tuple[int, float, float, float] | None:
        if not self.per_cycle:
            return None
        return (
            len(self.per_cycle),
            min(self.per_cycle) * 1000,
            self._percentile(self.per_cycle, 50) * 1000,
            max(self.per_cycle) * 1000,
        )


def time_call(fn: Callable[[], object]) -> float:
    """Time one call's wall-clock seconds, discarding the return value."""
    t0 = time.monotonic()
    fn()
    return time.monotonic() - t0


# --- strategies -----------------------------------------------------------


def bench_serial(
    name: str,
    client_factory: Callable[[], object],
    bucket: str,
    prefixes: list[str],
    samples: int,
    *,
    fresh_client_each_call: bool,
) -> StrategyResult:
    """Walk prefixes serially; record per-call and per-cycle time."""
    result = StrategyResult(name=name)
    shared = None if fresh_client_each_call else client_factory()
    for sample_idx in range(samples):
        cycle_start = time.monotonic()
        for prefix in prefixes:
            client = client_factory() if fresh_client_each_call else shared
            assert client is not None
            label = f"sample{sample_idx}:{prefix}"
            secs = time_call(
                lambda c=client, p=prefix: list_prefix_paginator(c, bucket, p)
            )
            result.per_call.append(Sample(label=label, seconds=secs))
        result.per_cycle.append(time.monotonic() - cycle_start)
    return result


def bench_parallel(
    name: str,
    client_factory: Callable[[], object],
    bucket: str,
    prefixes: list[str],
    samples: int,
    workers: int,
    *,
    fresh_client_per_worker: bool,
) -> StrategyResult:
    """Run prefixes concurrently with a fixed worker pool.

    Per-call times are individual list latencies (apples-to-apples vs.
    serial). Per-cycle time is the wall-clock from cycle start until
    the last worker returns — this is what the next poll cycle waits
    on, and where parallelism actually shows up.
    """
    result = StrategyResult(name=name)
    shared = None if fresh_client_per_worker else client_factory()

    def one_call(prefix: str, sample_idx: int) -> Sample:
        client = client_factory() if fresh_client_per_worker else shared
        assert client is not None
        secs = time_call(lambda: list_prefix_paginator(client, bucket, prefix))
        return Sample(label=f"sample{sample_idx}:{prefix}", seconds=secs)

    for sample_idx in range(samples):
        cycle_start = time.monotonic()
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(one_call, p, sample_idx) for p in prefixes]
            for fut in futures:
                result.per_call.append(fut.result())
        result.per_cycle.append(time.monotonic() - cycle_start)
    return result


def bench_head_during_list(
    name: str,
    client_factory: Callable[[], object],
    bucket: str,
    busy_prefix: str,
    head_key: str,
    samples: int,
    *,
    shared_client: bool,
) -> StrategyResult:
    """Measure HEAD latency while a list_objects_v2 is in flight.

    Two clients are built either way; ``shared_client=True`` uses the
    *same* client for both ops. The list is started ~0.1s before the
    HEAD to make sure the HEAD lands during the listing.
    """
    result = StrategyResult(name=name)
    list_client = client_factory()
    head_client = list_client if shared_client else client_factory()

    for sample_idx in range(samples):
        with ThreadPoolExecutor(max_workers=2) as pool:
            list_future = pool.submit(
                list_prefix_paginator, list_client, bucket, busy_prefix
            )
            time.sleep(0.1)  # give the list a head start
            t0 = time.monotonic()
            head_one(head_client, bucket, head_key)
            head_secs = time.monotonic() - t0
            list_future.result()  # wait for the list to finish too
        result.per_call.append(
            Sample(
                label=f"sample{sample_idx}:head",
                seconds=head_secs,
                detail="shared" if shared_client else "separate",
            )
        )
    return result


def bench_raw_vs_paginator(
    name: str,
    client_factory: Callable[[], object],
    bucket: str,
    prefixes: list[str],
    samples: int,
    *,
    raw: bool,
) -> StrategyResult:
    """Compare ``client.get_paginator`` against a manual ContinuationToken loop."""
    result = StrategyResult(name=name)
    client = client_factory()
    fn = list_prefix_raw if raw else list_prefix_paginator
    for sample_idx in range(samples):
        cycle_start = time.monotonic()
        for prefix in prefixes:
            secs = time_call(lambda p=prefix: fn(client, bucket, p))
            result.per_call.append(
                Sample(label=f"sample{sample_idx}:{prefix}", seconds=secs)
            )
        result.per_cycle.append(time.monotonic() - cycle_start)
    return result


# --- reporting ------------------------------------------------------------


def print_table(results: list[StrategyResult]) -> None:
    """Plain-text aligned table — per-call latency and per-cycle latency.

    Per-call columns measure individual list/HEAD wall-clock — useful
    for comparing strategies on the underlying S3 latency they incur.
    Per-cycle columns measure the full "list every prefix once" pass —
    this is the figure that determines how stale the data gets between
    poll cycles, and where parallelism shows up.
    """
    print(
        f"{'strategy':<32}"
        f"{'n':>4}"
        f"  {'call.min':>8} {'call.p50':>8} {'call.p95':>8} {'call.max':>8}"
        f"   {'cycle.min':>9} {'cycle.p50':>9} {'cycle.max':>9}   (ms)"
    )
    print("-" * 120)

    for r in results:
        call = r.call_stats()
        cycle = r.cycle_stats()
        if call[0] == 0:
            continue
        _, c_min, c_p50, c_p95, c_max, _ = call
        if cycle is None:
            cyc_str = f"{'—':>9} {'—':>9} {'—':>9}"
        else:
            _, cy_min, cy_p50, cy_max = cycle
            cyc_str = f"{cy_min:>9.1f} {cy_p50:>9.1f} {cy_max:>9.1f}"
        print(
            f"{r.name:<32}"
            f"{call[0]:>4d}"
            f"  {c_min:>8.1f} {c_p50:>8.1f} {c_p95:>8.1f} {c_max:>8.1f}"
            f"   {cyc_str}"
        )


# --- entry point ----------------------------------------------------------


def parse_args() -> argparse.Namespace:
    """Argparse setup for the benchmark CLI."""
    p = argparse.ArgumentParser(
        description="Benchmark S3 polling strategies for RubinTV."
    )
    p.add_argument("--profile", default=None, help="AWS profile name (optional).")
    p.add_argument("--endpoint", default=None, help="S3 endpoint URL.")
    p.add_argument("--bucket", required=True, help="Bucket name.")
    p.add_argument(
        "--prefix",
        action="append",
        required=True,
        help="Prefix to list. Pass multiple --prefix flags to bench several.",
    )
    p.add_argument(
        "--head-key",
        default=None,
        help="Key for HEAD-during-list test (e.g. .../metadata.json).",
    )
    p.add_argument(
        "--samples",
        type=int,
        default=5,
        help="Number of samples per strategy (default 5).",
    )
    p.add_argument(
        "--parallel",
        nargs="+",
        type=int,
        default=[2, 4, 8],
        help="Worker counts for parallel strategies (default: 2 4 8).",
    )
    return p.parse_args()


def main() -> int:
    """Run all chosen strategies and print the summary table."""
    args = parse_args()

    def factory() -> object:
        return make_client(args.profile, args.endpoint)

    results: list[StrategyResult] = []

    # Serial baselines.
    results.append(
        bench_serial(
            "serial-shared",
            factory,
            args.bucket,
            args.prefix,
            args.samples,
            fresh_client_each_call=False,
        )
    )
    results.append(
        bench_serial(
            "serial-per-prefix",
            factory,
            args.bucket,
            args.prefix,
            args.samples,
            fresh_client_each_call=True,
        )
    )

    # Paginator vs raw loop (apples-to-apples, shared client).
    results.append(
        bench_raw_vs_paginator(
            "paginator-shared",
            factory,
            args.bucket,
            args.prefix,
            args.samples,
            raw=False,
        )
    )
    results.append(
        bench_raw_vs_paginator(
            "raw-shared",
            factory,
            args.bucket,
            args.prefix,
            args.samples,
            raw=True,
        )
    )

    # Parallel sweeps.
    for workers in args.parallel:
        results.append(
            bench_parallel(
                f"parallel-{workers}-shared",
                factory,
                args.bucket,
                args.prefix,
                args.samples,
                workers,
                fresh_client_per_worker=False,
            )
        )
        results.append(
            bench_parallel(
                f"parallel-{workers}-per-worker",
                factory,
                args.bucket,
                args.prefix,
                args.samples,
                workers,
                fresh_client_per_worker=True,
            )
        )

    # HEAD-during-list latency (the interactive metadata case).
    if args.head_key:
        results.append(
            bench_head_during_list(
                "head-during-list-shared",
                factory,
                args.bucket,
                args.prefix[0],
                args.head_key,
                args.samples,
                shared_client=True,
            )
        )
        results.append(
            bench_head_during_list(
                "head-during-list-separate",
                factory,
                args.bucket,
                args.prefix[0],
                args.head_key,
                args.samples,
                shared_client=False,
            )
        )

    print_table(results)
    return 0


if __name__ == "__main__":
    sys.exit(main())
