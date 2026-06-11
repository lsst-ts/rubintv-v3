"""Mock cluster-status producer for local Cluster Status page testing.

Writes worker statuses to the ``stream:CLUSTER_STATUS_*`` Redis streams the app
subscribes to (one stream per ``redis_detectors`` config entry), in the same
shape the real producer uses: each XADD carries a single ``data`` field holding
``{worker: {"status", "type"}}`` JSON.

Unlike a pure-random feed, this keeps **persistent per-worker state** that looks
like a steady-ish cluster (mostly free, some busy) and only churns a little each
tick. Periodically a *queue burst* hits a cluster of imaging workers, but the
total queued imaging workers is capped at a quarter of all imaging cells, so the
grid never goes fully red — you see localised, sudden queues that drain back to
steady state.

Adapted from rubintv/local_scripts/stream_writer_demo.py.

Usage:
    uv run python scripts/detector_stream_demo.py        # loop, ~2 Hz
    uv run python scripts/detector_stream_demo.py once    # one snapshot
"""

from __future__ import annotations

import json
import random
import sys
import time

import redis

# Detector ids per set type, matching web/src/data/*.json so the canvas fills.
# Imaging sets cover the full focal plane (detectorMap ids 0..188); CWFS sets
# use the eight corner-wavefront sensors (cwfsMap ids).
IMAGING_IDS = [str(i) for i in range(189)]
CWFS_IDS = ["191", "192", "195", "196", "199", "200", "203", "204"]

IMAGING_SETS = ["CLUSTER_STATUS_SFM_SET_0", "CLUSTER_STATUS_SFM_SET_1"]
CWFS_SETS = [
    "CLUSTER_STATUS_AOS_SET_0",
    "CLUSTER_STATUS_AOS_SET_1",
    "CLUSTER_STATUS_AOS_SET_2",
    "CLUSTER_STATUS_AOS_SET_3",
]
STEP1B_SETS = ["CLUSTER_STATUS_SFM_STEP1B_SET_0", "CLUSTER_STATUS_AOS_STEP1B_SET_0"]
STEP1B_COUNT = 8
SPARE_COUNT = 4

# Cap on queued imaging workers: no more than a quarter of all imaging cells
# (across both imaging sets) may be queued at once.
IMAGING_QUEUE_FRACTION = 0.25

# Steady-state churn: each tick, this fraction of free<->busy workers may flip.
CHURN = 0.06
# Chance per tick of starting a new queue burst (when capacity allows).
BURST_CHANCE = 0.15


class WorkerSet:
    """Persistent status for one set's workers, evolved a little each tick."""

    def __init__(self, ids: list[str]) -> None:
        # Start mostly free with a scattering of busy — a calm steady state.
        self.ids = ids
        self.status: dict[str, str] = {
            i: ("busy" if random.random() < 0.25 else "free") for i in ids
        }
        # queue_length per queued worker (only set while status == "queued").
        self.queue: dict[str, int] = {}

    def num_queued(self) -> int:
        return sum(1 for s in self.status.values() if s == "queued")

    def churn(self) -> None:
        """Small steady-state movement: a few free<->busy flips, rare restart."""
        for i in self.ids:
            s = self.status[i]
            if s in ("free", "busy") and random.random() < CHURN:
                self.status[i] = "busy" if s == "free" else "free"
            elif s == "restarting" and random.random() < 0.4:
                # Restarting workers settle back to free.
                self.status[i] = "free"

    def drain_queues(self) -> None:
        """Queued workers count down and return to busy/free as they clear."""
        for i in list(self.queue):
            self.queue[i] -= 1
            if self.queue[i] <= 0:
                del self.queue[i]
                self.status[i] = "busy" if random.random() < 0.5 else "free"

    def start_burst(self, max_workers: int) -> None:
        """Queue a localised cluster of up to ``max_workers`` free/busy workers."""
        if max_workers <= 0:
            return
        candidates = [i for i in self.ids if self.status[i] in ("free", "busy")]
        if not candidates:
            return
        size = random.randint(1, min(max_workers, len(candidates)))
        # A contiguous-ish cluster: pick a random start index into the id list
        # and take a run, so the queue looks like a localised hot spot.
        start = random.randrange(len(candidates))
        for i in candidates[start : start + size]:
            self.status[i] = "queued"
            self.queue[i] = random.randint(2, 6)  # ticks until it clears

    def payload(self, *, with_count: bool = False) -> dict[str, dict[str, str]]:
        data: dict[str, dict[str, str]] = {}
        for i in self.ids:
            s = self.status[i]
            value = str(self.queue[i]) if s == "queued" else s
            data[i] = {"status": value, "type": "worker_status"}
        if with_count:
            data["numWorkers"] = {"status": str(len(self.ids)), "type": "worker_count"}
        return data


class Cluster:
    """The whole cluster's persistent state across ticks."""

    def __init__(self) -> None:
        self.imaging = {k: WorkerSet(IMAGING_IDS) for k in IMAGING_SETS}
        self.cwfs = {k: WorkerSet(CWFS_IDS) for k in CWFS_SETS}
        self.step1b = {
            k: WorkerSet([str(i) for i in range(STEP1B_COUNT)]) for k in STEP1B_SETS
        }
        self.spare = WorkerSet([str(i) for i in range(SPARE_COUNT)])

    def tick(self) -> None:
        every = [
            *self.imaging.values(),
            *self.cwfs.values(),
            *self.step1b.values(),
            self.spare,
        ]
        for ws in every:
            ws.churn()
            ws.drain_queues()

        # Imaging queue bursts, capped at a quarter of all imaging cells.
        total_imaging = len(IMAGING_IDS) * len(self.imaging)
        cap = int(total_imaging * IMAGING_QUEUE_FRACTION)
        queued_now = sum(ws.num_queued() for ws in self.imaging.values())
        if queued_now < cap and random.random() < BURST_CHANCE:
            target = random.choice(list(self.imaging.values()))
            self.start_burst_capped(target, cap - queued_now)

        # CWFS sets get the occasional single-worker queue too (small sets).
        for ws in self.cwfs.values():
            if ws.num_queued() == 0 and random.random() < 0.05:
                ws.start_burst(1)

    @staticmethod
    def start_burst_capped(ws: WorkerSet, remaining_cap: int) -> None:
        # Localised burst, but never exceed the remaining imaging queue budget.
        ws.start_burst(min(remaining_cap, max(1, len(ws.ids) // 8)))


def write_all(r: redis.Redis, cluster: Cluster) -> None:
    pipe = r.pipeline()

    for key, ws in cluster.imaging.items():
        _xadd(pipe, key, ws.payload())
    for key, ws in cluster.cwfs.items():
        _xadd(pipe, key, ws.payload())
    for key, ws in cluster.step1b.items():
        _xadd(pipe, key, ws.payload(with_count=True))

    _xadd(pipe, "CLUSTER_STATUS_SPAREWORKERS_SET_0", cluster.spare.payload(with_count=True))

    # Other queues — free-text rows that drift slowly.
    other = {
        f"queue_{name}": {
            "status": str(max(0, base + random.randint(-2, 2))),
            "type": "text_status",
        }
        for name, base in (("alerts", 4), ("isr", 18), ("calib", 1), ("diffim", 7))
    }
    _xadd(pipe, "CLUSTER_STATUS_OTHER_QUEUES", other)

    # redis-py leaves Pipeline.execute unannotated; the call itself is fine.
    pipe.execute()  # type: ignore[no-untyped-call]


def _xadd(
    pipe: redis.client.Pipeline, key: str, data: dict[str, dict[str, str]]
) -> None:
    pipe.xadd(
        f"stream:{key}", {"data": json.dumps(data)}, maxlen=1000, approximate=True
    )


def main() -> None:
    run_once = len(sys.argv) > 1 and sys.argv[1] == "once"
    r = redis.Redis(host="localhost", port=6379, db=0)
    cluster = Cluster()
    print(
        "writing detector streams"
        + (" (once)" if run_once else " (steady state w/ queue bursts; Ctrl-C to stop)")
    )
    try:
        while True:
            cluster.tick()
            write_all(r, cluster)
            if run_once:
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
