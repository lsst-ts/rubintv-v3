# S3 polling benchmark

Standalone script to compare S3 polling strategies against live RubinTV
buckets. Intended to run from a USDF-resident host (e.g. `sdfiana`*N*)
where the network path to the bucket endpoints is fast — locally from a
laptop, the WAN dominates and the choice of strategy is invisible.

Read-only: only `list_objects_v2` and `head_object` are issued.

## Run

```bash
source /sdf/group/rubin/sw/w_latest/loadLSST.sh
python scripts/benchmarks/bench_s3_poll.py \
    --profile rubin-rubintv-data-usdf-embargo \
    --endpoint https://sdfembs3.sdf.slac.stanford.edu \
    --bucket rubin-rubintv-data-usdf \
    --prefix lsstcam/2026-05-28/ \
    --prefix lsstcam_aos/2026-05-28/ \
    --prefix lsstcam_guider/2026-05-28/ \
    --head-key lsstcam/2026-05-28/metadata.json \
    --samples 10 \
    --parallel 2 4 8
```

Output is one line per strategy with two groups of columns:

- **per-call**: min / p50 / p95 / max of individual `list_objects_v2`
  call latencies. Useful for comparing the raw S3 cost of one prefix
  across strategies.
- **per-cycle**: min / p50 / max of a full pass over **all** prefixes.
  This is what actually matters for poll responsiveness — the wall
  clock of one cycle is how stale the data gets before the next
  refresh. Parallelism shows up here, not in the per-call numbers.

To see meaningful parallel speed-ups, pass several `--prefix` flags so
there's work to fan out across workers.

## What each strategy measures

| Strategy | What it isolates |
|---|---|
| `serial-shared` | Baseline: one prefix at a time, one shared boto3 client. |
| `serial-per-prefix` | Same, but a fresh client each call — exposes HTTP-pool / session reuse effects. |
| `paginator-shared` vs `raw-shared` | Whether boto3's paginator adds measurable overhead. |
| `parallel-N-shared` | Fan-out across the same client's connection pool. |
| `parallel-N-per-worker` | Fan-out with isolated clients — the "real fix" if pool contention dominates. |
| `head-during-list-shared` | HEAD latency for `metadata.json` while a list is in flight on the **same** client. The interactive-request case. |
| `head-during-list-separate` | Same, but with a separate client for the HEAD. Validates the "separate poller client" approach. |

## Reading the result

- If `parallel-N-per-worker` is roughly N× faster than `serial-shared`
  but `parallel-N-shared` is not, the HTTP connection pool is the
  bottleneck — split clients in the app.
- If `head-during-list-shared` is much slower than
  `head-during-list-separate`, then the metadata fetch is being starved
  by listing traffic on the same client.
- If both head-during-list cases are slow, the bucket / endpoint
  serialises requests upstream regardless of client.
