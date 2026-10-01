"""The smallest program over the binding: load the compiled core and print its version."""

from zero_server.core import version

# ANCHOR: version
core = version()
print(f"zero-server core {core}")
# ANCHOR_END: version

if not isinstance(core, str) or core == "":
    raise AssertionError("version() should return a non-empty string")
