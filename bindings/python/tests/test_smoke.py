"""Smoke test: confirms the native core loads and reports its version, and that
the facade and the raw escape hatch report the same one."""

from zero_server import _native


def test_native_version_returns_string():
    version = _native.version()
    assert isinstance(version, str)
    assert version != ""


def test_core_facade_reports_the_native_version():
    from zero_server import core

    assert core.version() == _native.version()


def test_raw_escape_hatch_exposes_the_native_contract():
    from zero_server import raw

    assert hasattr(raw, "version")
    assert raw.version() == _native.version()
