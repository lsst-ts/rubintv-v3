"""Sub-app integration: DDV and exp_checker.

Both mount as sub-paths of the main app and are isolated: a sub-app that
fails to initialise (missing assets, import error) is logged and skipped —
it never blocks main-app startup (design doc, Phase 6).
"""

from rubintv.subapps.mount import mount_subapps

__all__ = ["mount_subapps"]
