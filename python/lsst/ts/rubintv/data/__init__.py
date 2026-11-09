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

"""The data layer: ingestion, in-memory index, and change notification.

Three decoupled pieces (see the design doc, Phase 2):

- :mod:`rubintv.data.source` — ``DataSource`` emits ``ObjectEvent``s
  (how objects arrive: polling now, Kafka later).
- :mod:`rubintv.data.store` — ``EventStore`` indexes them (the single
  source of truth the API reads).
- :mod:`rubintv.data.bus` — ``EventBus`` fans ``StoreChange``s out to
  listeners (WebSocket, cache invalidation) without the store knowing who
  is listening.
"""
