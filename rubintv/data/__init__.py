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
