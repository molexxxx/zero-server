"""The zero-server core's surface: the runtime version of the compiled core.

This is the counterpart of the ``zero-core`` crate, and like it, it is small; the
compiled core is ``zero-server-native``, which this package depends on. The
``zero-server`` distribution installs every package of the framework.
"""

from __future__ import annotations

from zero_server._native import version

__all__ = ["version"]
