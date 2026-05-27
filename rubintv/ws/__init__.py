"""WebSocket real-time layer.

One endpoint (``/ws``), one connection per tab. Clients subscribe to topics
(camera, channel, night-report, detectors, admin); the server translates
``StoreChange``s from the EventBus into typed messages and fans them out to
matching subscribers.
"""
