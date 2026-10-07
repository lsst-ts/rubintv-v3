# This file is part of rubintv-v3.
#
# Developed for the Vera C. Rubin Observatory Telescope and Site Systems.
# This product includes software developed by the LSST Project
# (https://www.lsst.org).
# See the COPYRIGHT file at the top-level directory of this distribution
# for details of code ownership.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

"""scripts/flow_summary.py: aggregate the data-flow log events."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "flow_summary.py"

SAMPLE = [
    "INFO:     Uvicorn running on http://127.0.0.1:8000 (not JSON, skipped)",
    {
        "event": "http.request",
        "method": "GET",
        "path": "/rubintv/api/locations/usdf/cameras/lsstcam/dates/2026-10-07",
        "status": 200,
        "duration_ms": 12.5,
        "bytes": 2048,
    },
    {
        "event": "http.request",
        "method": "GET",
        "path": "/rubintv/api/locations/usdf/cameras/lsstcam/dates/2026-10-06",
        "status": 200,
        "duration_ms": 30.0,
        "bytes": 4096,
    },
    {
        "event": "http.request",
        "method": "GET",
        "path": "/rubintv/api/proxy/usdf/lsstcam/2026-10-07/monitor/000012",
        "status": 200,
        "duration_ms": 3.0,
        "bytes": None,
    },
    {"event": "ws.frame.sent", "type": "channelData", "bytes": 120},
    {"event": "ws.frame.sent", "type": "metadataChunk", "bytes": 50000},
    {"event": "ws.disconnect", "frames_sent": 2, "bytes_sent": 50120},
    {"event": "poll.current.cycle", "cycle_seconds": 0.8, "keys": 6000},
    {"event": "poll.current.cycle", "cycle_seconds": 1.2, "keys": 6002},
    {"event": "poll.scan", "scope": "day", "keys": 6000, "slices_touched": 0},
    {"event": "poll.scan", "scope": "day", "keys": 6002, "slices_touched": 1},
    {"event": "store.apply", "events": 6002, "changes": 2},
]


def test_summary_folds_paths_and_reports_each_flow() -> None:
    stdin = "\n".join(s if isinstance(s, str) else json.dumps(s) for s in SAMPLE)
    out = subprocess.run(
        [sys.executable, str(SCRIPT)], input=stdin, capture_output=True, text=True
    )
    assert out.returncode == 0, out.stderr
    text = out.stdout
    # Both date requests fold into one endpoint row with p50/p95 and bytes.
    assert "GET /rubintv/api/locations/usdf/cameras/lsstcam/dates/{date}" in text
    assert "/proxy/usdf/lsstcam/{date}/monitor/{n}" in text
    assert "6144" in text  # 2048 + 4096 bytes on the dates row
    assert "metadataChunk" in text and "50000" in text
    assert "1 connection(s) closed: 2 frames, 50120 bytes" in text
    assert "2 cycles" in text and "max 1.200" in text
    assert "6002 events -> 2 changes" in text
