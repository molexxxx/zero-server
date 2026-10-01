"""Low-level generated contract for the zero-server core (the escape hatch).

This module re-exports the native :mod:`zero_server._native` extension verbatim. It
is the Python analog of ``@zero-server/native`` in the Node binding: anything the
ergonomic facade does not surface is still reachable here without leaving the SDK.
"""

from zero_server import _native
from zero_server._native import *  # noqa: F401,F403

__all__ = [name for name in dir(_native) if not name.startswith("_")]
