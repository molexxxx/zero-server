"""Fixtures the C ABI tests share: the shared library, loaded once per run."""

import ctypes

import pytest

import cabi


@pytest.fixture(scope="session")
def lib() -> ctypes.CDLL:
    """``libzero_ffi`` loaded with ``ctypes.CDLL``, every prototype the tests call declared."""
    return cabi.load()
